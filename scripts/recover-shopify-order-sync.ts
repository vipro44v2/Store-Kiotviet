/**
 * Targeted recovery for failed Shopify → KiotViet order jobs (e.g. the
 * shopify_order_update "Cannot read properties of null (reading 'trim')" failures).
 * Dry run by default; never touches orders that were not named explicitly.
 *
 *   npx tsx --env-file=.env.local scripts/recover-shopify-order-sync.ts --list
 *   npx tsx --env-file=.env.local scripts/recover-shopify-order-sync.ts <shopifyOrderId> [...]
 *   npx tsx --env-file=.env.local scripts/recover-shopify-order-sync.ts <shopifyOrderId> [...] --apply
 *   npx tsx --env-file=.env.local scripts/recover-shopify-order-sync.ts <shopifyOrderId> --link-kiotviet-order <kiotVietOrderId> --apply
 */
import { query, transaction, closeDatabase } from "../lib/db/client";
import { closeQueues, enqueueJob } from "../lib/queue/queues";
import { closeRedis } from "../lib/redis/client";
import { kiotVietClient } from "../lib/kiotviet/client";
import { findKiotVietOrderByShopifyReference } from "../lib/kiotviet/orders";
import { validateOrderLineItems } from "../lib/sync/order-sync";
import { getSyncSettings } from "../lib/sync/sync-settings";
import type { ShopifyOrderWebhook } from "../types/shopify";

interface Mapping {
  shopify_order_id: string;
  shopify_order_number: string | null;
  kiotviet_order_id: string | null;
  status: string | null;
  sync_status: string | null;
  failure_stage: string | null;
  last_error: string | null;
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const linkIndex = args.indexOf("--link-kiotviet-order");
const linkKiotVietOrderId = linkIndex >= 0 ? args[linkIndex + 1] : undefined;
const orderIds = args.filter((arg, index) => /^\d+$/.test(arg) && index !== linkIndex + 1);
const print = (line: string) => process.stdout.write(`${line}\n`);

async function list() {
  const rows = await query<Record<string, unknown>>(
    `SELECT w.external_resource_id AS shopify_order_id, m.shopify_order_number, m.status AS mapping_status,
      m.sync_status, j.type, j.status AS job_status, j.attempts, j.error_code, left(j.error, 160) AS error, j.updated_at
    FROM sync_jobs j
    JOIN webhook_events w ON w.id::text = j.payload->>'eventId'
    LEFT JOIN order_mappings m ON m.shopify_order_id = w.external_resource_id
    WHERE j.type IN ('shopify_order_create','shopify_order_update')
      AND j.status IN ('failed','manual_review')
      AND m.kiotviet_order_id IS NULL
      AND j.updated_at > now() - interval '60 days'
    ORDER BY j.updated_at DESC LIMIT 200`,
  );
  if (!rows.length) return print("No failed Shopify order jobs without a KiotViet order.");
  for (const row of rows) print(JSON.stringify(row));
  print("\nRe-run with explicit Shopify order IDs (dry run) to see the recovery plan for each order.");
}

async function latestOrderEvent(orderId: string) {
  const [event] = await query<{ id: string; payload: ShopifyOrderWebhook }>(
    `SELECT id,payload FROM webhook_events
    WHERE provider='shopify' AND external_resource_id=$1 AND event_type IN ('orders/updated','orders/create')
    ORDER BY received_at DESC LIMIT 1`,
    [orderId],
  );
  return event;
}

/** Creates the mapping row when missing, so later webhooks update instead of creating a duplicate. */
async function linkOrder(orderId: string, kiotVietOrderId: number, code: string) {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shopify-order:${orderId}`]);
    const updated = await client.query(
      `INSERT INTO order_mappings(shopify_order_id,kiotviet_order_id,kiotviet_order_code,status,sync_status,last_sync_at)
      VALUES($1,$2,$3,'created','synced',now())
      ON CONFLICT(shopify_order_id) DO UPDATE SET kiotviet_order_id=EXCLUDED.kiotviet_order_id,
        kiotviet_order_code=EXCLUDED.kiotviet_order_code,status='created',sync_status='synced',
        claim_token=NULL,last_error=NULL,failure_stage=NULL,last_sync_at=now(),updated_at=now()
      WHERE order_mappings.kiotviet_order_id IS NULL`,
      [orderId, kiotVietOrderId, code],
    );
    if (!updated.rowCount) throw new Error(`Order ${orderId} is already linked; nothing changed`);
  });
}

async function recover(orderId: string) {
  print(`\n== Shopify order ${orderId}`);
  const [mapping] = await query<Mapping>(
    "SELECT shopify_order_id,shopify_order_number,kiotviet_order_id,status,sync_status,failure_stage,last_error FROM order_mappings WHERE shopify_order_id=$1",
    [orderId],
  );
  print(`mapping: ${mapping ? JSON.stringify(mapping) : "none"}`);
  if (mapping?.kiotviet_order_id) return print("Already linked to a KiotViet order; nothing to do.");

  if (linkKiotVietOrderId) {
    const kiotVietOrder = await kiotVietClient.get<{ id: number; code: string; description?: string }>(
      `/orders/${Number(linkKiotVietOrderId)}`,
    );
    print(`KiotViet order ${kiotVietOrder.id} ${kiotVietOrder.code}: "${kiotVietOrder.description ?? ""}"`);
    if (!apply) return print(`PLAN: link to KiotViet order ${kiotVietOrder.code}. Re-run with --apply.`);
    await linkOrder(orderId, kiotVietOrder.id, kiotVietOrder.code);
    return print("Linked.");
  }

  const existing = await findKiotVietOrderByShopifyReference(orderId);
  if (existing) {
    print(`Found KiotViet order ${existing.code} referencing this Shopify order.`);
    if (!apply) return print(`PLAN: link to ${existing.code}. Re-run with --apply.`);
    await linkOrder(orderId, existing.id, existing.code);
    return print("Linked.");
  }
  print("No KiotViet order references this Shopify order.");

  const event = await latestOrderEvent(orderId);
  if (!event) return print("No stored orders/create or orders/updated webhook; wait for Shopify to send a new update.");
  try {
    validateOrderLineItems(event.payload);
  } catch (error) {
    // Shopify stores a line item's SKU at purchase time, so fixing the product does not fix this order.
    print(`Stored payload cannot be synced: ${error instanceof Error ? error.message : String(error)}`);
    return print(
      `Create the order in KiotViet manually with description "Shopify ${event.payload.name} (${orderId})", then run:\n` +
      `  scripts/recover-shopify-order-sync.ts ${orderId} --link-kiotviet-order <kiotVietOrderId> --apply`,
    );
  }

  const settings = await getSyncSettings();
  if (!settings.shopifyOrdersToKiotViet)
    return print("Shopify → KiotViet order sync is disabled; enable it before re-running.");
  const reset = mapping?.status === "creating" || mapping?.status === "pending_create";
  if (!apply)
    return print(`PLAN: ${reset ? `reset status ${mapping?.status} → create_failed, then ` : ""}enqueue one shopify_order_update job for event ${event.id}. Re-run with --apply.`);
  if (reset)
    await query(
      "UPDATE order_mappings SET status='create_failed',sync_status='failed',claim_token=NULL,failure_stage='manual_recovery',updated_at=now() WHERE shopify_order_id=$1 AND kiotviet_order_id IS NULL AND status IN ('creating','pending_create')",
      [orderId],
    );
  const job = await enqueueJob(
    "webhooks", "shopify_order_update", { eventId: event.id, recovery: true }, "normal",
    `recovery-shopify-order-${orderId}-${Date.now()}`,
  );
  print(`Enqueued job ${String(job.id)}.`);
}

async function main() {
  if (args.includes("--list")) return list();
  if (!orderIds.length) throw new Error("Pass --list or one or more Shopify order IDs");
  if (linkKiotVietOrderId && orderIds.length !== 1)
    throw new Error("--link-kiotviet-order requires exactly one Shopify order ID");
  print(apply ? "APPLY mode" : "DRY RUN (add --apply to make changes)");
  for (const orderId of orderIds) await recover(orderId);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await closeRedis();
    await closeDatabase();
  });
