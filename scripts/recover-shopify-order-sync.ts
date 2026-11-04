/**
 * Targeted recovery for failed or stuck Shopify → KiotViet orders.
 * Dry run (read-only) by default; --apply changes only the orders named on the
 * command line. See docs/order-inventory-sync.md.
 *
 *   npx tsx --env-file=.env.production scripts/recover-shopify-order-sync.ts --list
 *   npx tsx --env-file=.env.production scripts/recover-shopify-order-sync.ts 7128306221240
 *   npx tsx --env-file=.env.production scripts/recover-shopify-order-sync.ts 7128306221240 --apply
 *   npx tsx --env-file=.env.production scripts/recover-shopify-order-sync.ts 7128306221240 --link-kiotviet-order 24102572 --apply
 */
import { query, closeDatabase } from "../lib/db/client";
import { closeQueues } from "../lib/queue/queues";
import { closeRedis } from "../lib/redis/client";
import {
  applyOrderRecovery,
  describeRecoveryPlan,
  parseRecoveryArgs,
  planOrderRecovery,
  RECOVERY_USAGE,
  RecoveryArgsError,
} from "../lib/recovery/shopify-order-recovery";

const print = (line: string) => process.stdout.write(`${line}\n`);

async function list() {
  const stuck = await query<Record<string, unknown>>(
    `SELECT m.shopify_order_id,m.shopify_order_number,m.status,m.sync_status,m.failure_stage,left(m.last_error,160) AS last_error,m.updated_at
    FROM order_mappings m
    WHERE m.kiotviet_order_id IS NULL AND m.status IN ('creating','pending_create','create_failed')
    ORDER BY m.updated_at DESC LIMIT 200`,
  );
  print(`Unlinked order mappings (${stuck.length}):`);
  for (const row of stuck) print(JSON.stringify(row));
  const failed = await query<Record<string, unknown>>(
    `SELECT DISTINCT ON (w.external_resource_id) w.external_resource_id AS shopify_order_id,j.type,j.status,j.attempts,
      j.error_code,left(j.error,160) AS error,j.updated_at
    FROM sync_jobs j
    JOIN webhook_events w ON w.id::text=j.payload->>'eventId'
    LEFT JOIN order_mappings m ON m.shopify_order_id=w.external_resource_id
    WHERE j.type IN ('shopify_order_create','shopify_order_update') AND j.status IN ('failed','manual_review')
      AND m.kiotviet_order_id IS NULL AND j.updated_at > now()-interval '60 days'
    ORDER BY w.external_resource_id,j.updated_at DESC LIMIT 200`,
  );
  print(`\nLatest failed order job per unlinked Shopify order (${failed.length}):`);
  for (const row of failed) print(JSON.stringify(row));
  print("\nNext: run a dry run with explicit Shopify order IDs to see the plan for each order.");
}

async function main() {
  const args = parseRecoveryArgs(process.argv.slice(2));
  if (args.mode === "list") return list();
  print(args.apply ? "APPLY mode: only the orders listed below are changed" : "DRY RUN: read-only (add --apply to make changes)");
  for (const orderId of args.shopifyOrderIds) {
    const plan = await planOrderRecovery(orderId, { linkKiotVietOrderId: args.linkKiotVietOrderId });
    for (const line of describeRecoveryPlan(plan)) print(line);
    if (args.apply) print(`RESULT: ${(await applyOrderRecovery(plan)).message}`);
    print("");
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof RecoveryArgsError) process.stderr.write(`Error: ${error.message}\n\n${RECOVERY_USAGE}\n`);
    else process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await closeRedis();
    await closeDatabase();
  });
