import { query, transaction } from "@/lib/db/client";
import { enqueueJob } from "@/lib/queue/queues";
import { kiotVietClient } from "@/lib/kiotviet/client";
import { findKiotVietOrderByShopifyReference } from "@/lib/kiotviet/orders";
import {
  isOrderRecoveryWindowOpen,
  isPaid,
  ORDER_CLAIM_LEASE_MS,
  plannedOrderPayment,
  prepareOrderForKiotViet,
  refundReviewMessage,
  withFreshShopifyState,
  type PreparedOrder,
} from "@/lib/sync/order-sync";
import type { OrderSettings } from "@/lib/sync/default-branch";
import { normalizeSku } from "@/lib/sync/mappings";
import { lineAdjustmentAudit, productOnlyPolicy } from "@/lib/sync/product-only-invoicing";
import { getSyncSettings } from "@/lib/sync/sync-settings";
import type { ShopifyOrderWebhook } from "@/types/shopify";

export const RECOVERY_USAGE = `Usage:
  recover-shopify-order-sync.ts --list
  recover-shopify-order-sync.ts <shopifyOrderId> [<shopifyOrderId> ...] [--apply]
  recover-shopify-order-sync.ts <shopifyOrderId> --link-kiotviet-order <kiotVietOrderId> [--apply]
Positional arguments are always Shopify order IDs; a KiotViet order ID is only accepted after --link-kiotviet-order.`;

export type RecoveryArgs =
  | { mode: "list" }
  | { mode: "recover"; shopifyOrderIds: string[]; apply: boolean; linkKiotVietOrderId?: string };

export class RecoveryArgsError extends Error {}

const ID = /^[1-9]\d{0,19}$/;
function shopifyOrderId(value: string) {
  const id = value.startsWith("gid://shopify/Order/") ? value.slice("gid://shopify/Order/".length) : value;
  if (!ID.test(id))
    throw new RecoveryArgsError(`Invalid Shopify order ID "${value}": expected a positive integer such as 7128306221240`);
  return id;
}

export function parseRecoveryArgs(argv: string[]): RecoveryArgs {
  let list = false, apply = false, linkKiotVietOrderId: string | undefined;
  const ids: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--list") list = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--link-kiotviet-order" || arg.startsWith("--link-kiotviet-order=")) {
      if (linkKiotVietOrderId !== undefined)
        throw new RecoveryArgsError("--link-kiotviet-order may be given only once");
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      if (value === undefined || value.startsWith("--"))
        throw new RecoveryArgsError("--link-kiotviet-order requires a KiotViet order ID");
      if (!ID.test(value))
        throw new RecoveryArgsError(`Invalid KiotViet order ID "${value}": expected a positive integer`);
      linkKiotVietOrderId = value;
    } else if (arg.startsWith("-")) throw new RecoveryArgsError(`Unknown option ${arg}`);
    else ids.push(shopifyOrderId(arg));
  }
  if (list) {
    if (ids.length || apply || linkKiotVietOrderId)
      throw new RecoveryArgsError("--list is read-only and cannot be combined with order IDs, --apply or --link-kiotviet-order");
    return { mode: "list" };
  }
  const shopifyOrderIds = [...new Set(ids)];
  if (!shopifyOrderIds.length) throw new RecoveryArgsError("Pass --list or at least one Shopify order ID");
  if (linkKiotVietOrderId !== undefined) {
    if (shopifyOrderIds.length !== 1)
      throw new RecoveryArgsError("--link-kiotviet-order requires exactly one Shopify order ID");
    if (shopifyOrderIds[0] === linkKiotVietOrderId)
      throw new RecoveryArgsError("The KiotViet order ID equals the Shopify order ID; pass the KiotViet order's own ID");
  }
  return { mode: "recover", shopifyOrderIds, apply, linkKiotVietOrderId };
}

interface MappingRow {
  shopify_order_id: string;
  shopify_order_number: string | null;
  kiotviet_order_id: string | null;
  status: string | null;
  sync_status: string | null;
  failure_stage: string | null;
  claimed_at: string | null;
  updated_at: string;
}
interface KiotVietOrderRef { id: number; code: string }

export type RecoveryAction =
  | { kind: "none"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "manual_create_required"; reason: string }
  | { kind: "link"; source: "existing_reference" | "manual"; kiotVietOrder: KiotVietOrderRef }
  | { kind: "requeue"; eventId: string; resetFrom: string | null };

export interface RecoveryPlan {
  shopifyOrderId: string;
  mapping?: MappingRow;
  eventId?: string;
  prepared?: PreparedOrder;
  /** Shopify's current state (the stored webhook may be outdated), as the worker will see it. */
  current?: {
    financialStatus: string | null;
    storedFinancialStatus: string | null;
    cancelled: boolean;
    paymentEligible: boolean;
    /** Exact totalPayment the KiotViet order would be created with. */
    plannedPayment: number | null;
    readError?: string;
  };
  /** Refund ambiguities that block creation (empty when none). */
  ambiguous?: string[];
  /** Linked orders: KiotViet lines vs Shopify's current effective lines (report only, never applied). */
  reconciliation?: Array<{ sku: string; kiotVietQuantity: number; shopifyEffectiveQuantity: number }>;
  action: RecoveryAction;
}

/**
 * Report only: compares an existing KiotViet order's lines with Shopify's current effective
 * lines (after confirmed cancelled refunds). Differences are never applied automatically; they
 * are reconciled explicitly in KiotViet (refund_after_kiotviet_order also blocks the invoice).
 */
async function linkedReconciliation(orderId: string, kiotVietOrderId: number, stored: ShopifyOrderWebhook | undefined, settings: OrderSettings): Promise<Partial<RecoveryPlan>> {
  try {
    const order = await withFreshShopifyState(stored ?? ({ id: Number(orderId), name: "", total_price: "0", line_items: [] } as ShopifyOrderWebhook));
    const prepared = prepareOrderForKiotViet(order, settings);
    const kiotVietOrder = await kiotVietClient.get<{ orderDetails?: Array<{ productCode?: string; quantity: number }> }>(`/orders/${kiotVietOrderId}`);
    const effective = new Map<string, number>();
    for (const line of prepared.lines) effective.set(line.sku, (effective.get(line.sku) ?? 0) + line.quantity);
    const onOrder = new Map<string, number>();
    for (const detail of kiotVietOrder?.orderDetails ?? []) {
      const sku = normalizeSku(detail.productCode);
      onOrder.set(sku, (onOrder.get(sku) ?? 0) + Number(detail.quantity));
    }
    const reconciliation = [...new Set([...effective.keys(), ...onOrder.keys()])]
      .filter((sku) => (effective.get(sku) ?? 0) !== (onOrder.get(sku) ?? 0))
      .map((sku) => ({ sku, kiotVietQuantity: onOrder.get(sku) ?? 0, shopifyEffectiveQuantity: effective.get(sku) ?? 0 }));
    return { prepared, reconciliation, ambiguous: prepared.adjustments?.ambiguous ?? [],
      current: { financialStatus: order.financial_status ?? null, storedFinancialStatus: stored?.financial_status ?? null,
        cancelled: Boolean(order.cancelled_at), paymentEligible: isPaid(order, settings), plannedPayment: null } };
  } catch (error) {
    return { current: { financialStatus: null, storedFinancialStatus: stored?.financial_status ?? null, cancelled: false, paymentEligible: false,
      plannedPayment: null, readError: error instanceof Error ? error.message : String(error) } };
  }
}

function referencesShopifyOrder(description: string | null | undefined, orderId: string) {
  return new RegExp(`(^|\\D)${orderId}(\\D|$)`).test(description ?? "");
}

/** Read-only: SELECTs and KiotViet GETs only. */
export async function planOrderRecovery(
  orderId: string,
  options: { linkKiotVietOrderId?: string } = {},
): Promise<RecoveryPlan> {
  const [mapping] = await query<MappingRow>(
    "SELECT shopify_order_id,shopify_order_number,kiotviet_order_id::text,status,sync_status,failure_stage,claimed_at::text,updated_at::text FROM order_mappings WHERE shopify_order_id=$1",
    [orderId],
  );
  const plan = (action: RecoveryAction, extra: Partial<RecoveryPlan> = {}): RecoveryPlan =>
    ({ shopifyOrderId: orderId, mapping, ...extra, action });
  const [event] = await query<{ id: string; payload: ShopifyOrderWebhook }>(
    `SELECT id,payload FROM webhook_events
    WHERE provider='shopify' AND external_resource_id=$1 AND event_type IN ('orders/updated','orders/create')
    ORDER BY received_at DESC LIMIT 1`,
    [orderId],
  );
  const [settingsRow] = await query<{ value: OrderSettings }>("SELECT value FROM system_settings WHERE key='orders'");
  const settings = settingsRow?.value ?? {};
  if (mapping?.kiotviet_order_id)
    return plan({ kind: "none", reason: `already linked to KiotViet order ${mapping.kiotviet_order_id}; its lines are never changed automatically` },
      await linkedReconciliation(orderId, Number(mapping.kiotviet_order_id), event?.payload, settings));

  // Plan from Shopify's current state exactly as the worker will (withFreshShopifyState):
  // a stored webhook may predate refunds, cancellations or payment changes.
  let order: ShopifyOrderWebhook | undefined, readError: string | undefined;
  if (event)
    try { order = await withFreshShopifyState(event.payload); }
    catch (error) { readError = error instanceof Error ? error.message : String(error); }
  let prepared: PreparedOrder | undefined, invalid: unknown;
  if (order)
    try { prepared = prepareOrderForKiotViet(order, settings); }
    catch (error) { invalid = error; }
  const paymentEligible = order ? settings.paidOnly === false || isPaid(order, settings) : false;
  const extra: Partial<RecoveryPlan> = {
    eventId: event?.id, prepared, ambiguous: prepared?.adjustments?.ambiguous ?? [],
    current: event ? {
      financialStatus: order?.financial_status ?? null, storedFinancialStatus: event.payload.financial_status ?? null,
      cancelled: Boolean(order?.cancelled_at), paymentEligible,
      plannedPayment: order && prepared ? plannedOrderPayment(order, prepared, settings) : null,
      ...(readError ? { readError } : {}),
    } : undefined,
  };

  // Always look for an existing KiotViet order first: relinking beats recreating.
  const referenced = await findKiotVietOrderByShopifyReference(orderId);
  const ownerOf = async (kiotVietOrderId: number) =>
    (await query<{ shopify_order_id: string }>(
      "SELECT shopify_order_id FROM order_mappings WHERE kiotviet_order_id=$1", [kiotVietOrderId],
    ))[0]?.shopify_order_id;

  if (options.linkKiotVietOrderId) {
    const kiotVietOrder = await kiotVietClient.get<{ id: number; code: string; description?: string | null; status?: number }>(
      `/orders/${options.linkKiotVietOrderId}`,
    );
    if (!kiotVietOrder?.id || String(kiotVietOrder.id) !== options.linkKiotVietOrderId)
      return plan({ kind: "blocked", reason: `KiotViet order ${options.linkKiotVietOrderId} was not found` }, extra);
    if (!referencesShopifyOrder(kiotVietOrder.description, orderId))
      return plan({ kind: "blocked", reason: `KiotViet order ${kiotVietOrder.code} does not mention Shopify order ${orderId} in its description; add "(${orderId})" to it in KiotViet first` }, extra);
    if (referenced && referenced.id !== kiotVietOrder.id)
      return plan({ kind: "blocked", reason: `KiotViet order ${referenced.code} already references this Shopify order; refusing to link ${kiotVietOrder.code}` }, extra);
    if (kiotVietOrder.status === 4)
      return plan({ kind: "blocked", reason: `KiotViet order ${kiotVietOrder.code} is cancelled` }, extra);
    const owner = await ownerOf(kiotVietOrder.id);
    if (owner && owner !== orderId)
      return plan({ kind: "blocked", reason: `KiotViet order ${kiotVietOrder.code} is already linked to Shopify order ${owner}` }, extra);
    return plan({ kind: "link", source: "manual", kiotVietOrder: { id: kiotVietOrder.id, code: kiotVietOrder.code } }, extra);
  }
  if (referenced) {
    const owner = await ownerOf(referenced.id);
    if (owner && owner !== orderId)
      return plan({ kind: "blocked", reason: `KiotViet order ${referenced.code} references this order but is linked to Shopify order ${owner}` }, extra);
    return plan({ kind: "link", source: "existing_reference", kiotVietOrder: { id: referenced.id, code: referenced.code } }, extra);
  }

  if (!event) return plan({ kind: "blocked", reason: "no stored orders/create or orders/updated webhook; wait for Shopify to send an update" });
  if (readError || !order)
    return plan({ kind: "blocked", reason: `cannot read the current Shopify order (${readError}); nothing is planned from the stored webhook alone` }, extra);
  if (invalid)
    return plan({
      kind: "manual_create_required",
      reason: `${invalid instanceof Error ? invalid.message : String(invalid)}. Shopify keeps a line item's SKU as it was at purchase; create the order in KiotViet with description "Shopify ${event.payload.name} (${orderId})" and link it with --link-kiotviet-order`,
    }, extra);
  if (order.cancelled_at) return plan({ kind: "blocked", reason: "the Shopify order is cancelled" }, extra);
  if (settings.autoCreate === false) return plan({ kind: "blocked", reason: "orders.autoCreate is off; the worker would skip this order" }, extra);
  if (!paymentEligible)
    return plan({ kind: "blocked", reason: `not_paid: Shopify financial status is ${order.financial_status ?? "unknown"} (paid${productOnlyPolicy(settings).enabled ? " or partially_refunded" : ""} required)` }, extra);
  if (prepared!.adjustments?.ambiguous.length)
    return plan({ kind: "manual_create_required", reason: refundReviewMessage(order, prepared!.adjustments.ambiguous) }, extra);
  if (!prepared!.lines.length)
    return plan({ kind: "none", reason: prepared!.originalLines?.length
      ? "every product unit was cancelled by a confirmed refund; nothing to create in KiotViet"
      : "only processing-fee lines remain; nothing to create in KiotViet" }, extra);
  if (!(await getSyncSettings()).shopifyOrdersToKiotViet)
    return plan({ kind: "blocked", reason: "Shopify → KiotViet order sync is disabled" }, extra);
  if (mapping?.status === "pending_create" && mapping.claimed_at &&
      Date.now() - new Date(mapping.claimed_at).getTime() < ORDER_CLAIM_LEASE_MS)
    return plan({ kind: "blocked", reason: "a worker is creating this order right now" }, extra);
  if (mapping?.status === "creating" && isOrderRecoveryWindowOpen(mapping.claimed_at ?? mapping.updated_at))
    return plan({ kind: "blocked", reason: "a KiotViet create request may still be in flight; retry the dry run in 5 minutes" }, extra);
  const [activeJob] = await query<{ id: string; status: string }>(
    `SELECT j.id,j.status FROM sync_jobs j JOIN webhook_events w ON w.id::text=j.payload->>'eventId'
    WHERE w.provider='shopify' AND w.external_resource_id=$1 AND j.type IN ('shopify_order_create','shopify_order_update')
      AND (j.status IN ('pending','processing') OR (j.status='failed' AND j.attempts < j.max_attempts))
    LIMIT 1`,
    [orderId],
  );
  if (activeJob)
    return plan({ kind: "blocked", reason: `job ${activeJob.id} (${activeJob.status}) for this order may still run; wait for it to finish` }, extra);
  const resetFrom = mapping && (mapping.status === "creating" || mapping.status === "pending_create") ? mapping.status : null;
  return plan({ kind: "requeue", eventId: event.id, resetFrom }, extra);
}

/**
 * Applies exactly the planned action for one order. Every write is guarded by
 * the order's advisory lock and by the mapping state seen when planning, so a
 * concurrent recovery or worker makes this a no-op instead of a second order.
 */
export async function applyOrderRecovery(plan: RecoveryPlan): Promise<{ applied: boolean; message: string }> {
  const orderId = plan.shopifyOrderId, action = plan.action;
  if (action.kind === "link") {
    const linked = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shopify-order:${orderId}`]);
      const owner = await client.query<{ shopify_order_id: string }>(
        "SELECT shopify_order_id FROM order_mappings WHERE kiotviet_order_id=$1", [action.kiotVietOrder.id],
      );
      if (owner.rows[0] && owner.rows[0].shopify_order_id !== orderId) return false;
      const result = await client.query(
        `INSERT INTO order_mappings(shopify_order_id,kiotviet_order_id,kiotviet_order_code,status,sync_status,failure_stage,last_sync_at)
        VALUES($1,$2,$3,'created','synced','manual_recovery',now())
        ON CONFLICT(shopify_order_id) DO UPDATE SET kiotviet_order_id=EXCLUDED.kiotviet_order_id,
          kiotviet_order_code=EXCLUDED.kiotviet_order_code,status='created',sync_status='synced',claim_token=NULL,
          last_error=NULL,failure_stage='manual_recovery',last_sync_at=now(),updated_at=now(),
          -- A linked order may predate any earlier claim's floor: invoice lookups fall back to the full index.
          invoice_id_floor=NULL
        WHERE order_mappings.kiotviet_order_id IS NULL
        RETURNING shopify_order_id`,
        [orderId, action.kiotVietOrder.id, action.kiotVietOrder.code],
      );
      return Boolean(result.rows.length);
    });
    return linked
      ? { applied: true, message: `Linked to KiotViet order ${action.kiotVietOrder.code}` }
      : { applied: false, message: "Mapping changed since the dry run (already linked); nothing changed" };
  }
  if (action.kind !== "requeue") return { applied: false, message: `Nothing to apply (${action.kind})` };

  const claimed = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shopify-order:${orderId}`]);
    const result = plan.mapping
      ? await client.query(
          `UPDATE order_mappings SET status='create_failed',sync_status='failed',claim_token=NULL,last_error=NULL,
            failure_stage='manual_recovery',updated_at=now()
          WHERE shopify_order_id=$1 AND kiotviet_order_id IS NULL AND status IS NOT DISTINCT FROM $2 AND updated_at=$3::timestamptz
          RETURNING shopify_order_id`,
          [orderId, plan.mapping.status, plan.mapping.updated_at],
        )
      : await client.query(
          `INSERT INTO order_mappings(shopify_order_id,status,sync_status,failure_stage)
          VALUES($1,'create_failed','failed','manual_recovery') ON CONFLICT(shopify_order_id) DO NOTHING
          RETURNING shopify_order_id`,
          [orderId],
        );
    return Boolean(result.rows.length);
  });
  if (!claimed)
    return { applied: false, message: "Mapping changed since the dry run (another recovery or worker); nothing changed. Re-run the dry run." };
  // Deterministic job ID: the same planned recovery can only be queued once.
  const version = plan.mapping ? Date.parse(plan.mapping.updated_at) : 0;
  const job = await enqueueJob(
    "webhooks", "shopify_order_update", { eventId: action.eventId, recovery: true }, "normal",
    `recovery-shopify-order-${orderId}-${action.eventId}-${version}`,
  );
  return {
    applied: true,
    message: `${action.resetFrom ? `Reset ${action.resetFrom} → create_failed; ` : ""}enqueued one shopify_order_update job ${String(job.id)}`,
  };
}

export function describeRecoveryPlan(plan: RecoveryPlan): string[] {
  const lines = [`== Shopify order ${plan.shopifyOrderId}${plan.mapping?.shopify_order_number ? ` (${plan.mapping.shopify_order_number})` : ""}`];
  lines.push(plan.mapping
    ? `mapping: status=${plan.mapping.status} sync_status=${plan.mapping.sync_status} kiotviet_order_id=${plan.mapping.kiotviet_order_id ?? "null"}`
    : "mapping: none");
  if (plan.eventId) lines.push(`latest webhook event: ${plan.eventId}`);
  const current = plan.current;
  if (current) {
    lines.push(current.readError
      ? `current Shopify state: UNAVAILABLE (${current.readError})`
      : `current Shopify state: financial_status=${current.financialStatus} cancelled=${current.cancelled} payment_eligible=${current.paymentEligible}` +
        (current.storedFinancialStatus !== current.financialStatus ? ` (stored webhook says ${current.storedFinancialStatus}: outdated, not used)` : ""));
  }
  for (const fee of plan.prepared?.fees ?? [])
    lines.push(`skipped processing fee: line ${fee.line.id} "${fee.line.title ?? fee.line.name ?? ""}" sku=${fee.line.sku ?? "null"} amount=${fee.chargedCents / 100} (${fee.reason})`);
  for (const line of lineAdjustmentAudit(plan.prepared?.adjustments))
    lines.push(`refunded line ${line.lineItemId} SKU ${line.sku}: ordered=${line.originalQuantity} refunded=${line.refundedQuantity} excluded=${line.excludedQuantity} remaining=${line.remainingQuantity} fulfilled=${line.fulfilledQuantity ?? "n/a"} (${line.reason}: ${line.detail})`);
  for (const reason of plan.ambiguous ?? []) lines.push(`refund ambiguity (blocks creation): ${reason}`);
  if (plan.prepared) {
    const { shopifyTotal, excludedFeeTotal, consistent, expectedAdjustedTotal } = plan.prepared.amounts;
    lines.push(`amounts: shopify_total=${shopifyTotal} excluded_fees=${excludedFeeTotal}${consistent ? "" : ` (line/shipping sum ${expectedAdjustedTotal} differs; review)`}`);
    lines.push(`lines to send: ${plan.prepared.lines.map(({ sku, quantity }) => `${sku}×${quantity}`).join(", ") || "none"}`);
  }
  if (current?.plannedPayment != null) lines.push(`planned KiotViet totalPayment: ${current.plannedPayment}`);
  for (const item of plan.reconciliation ?? [])
    lines.push(`RECONCILE (manual, never automatic): SKU ${item.sku} is ${item.kiotVietQuantity} on the KiotViet order but ${item.shopifyEffectiveQuantity} in Shopify now`);
  const action = plan.action;
  lines.push(
    action.kind === "link" ? `PLAN: link to existing KiotViet order ${action.kiotVietOrder.code} (${action.source}); no new order is created`
    : action.kind === "requeue" ? `PLAN: ${action.resetFrom ? `reset ${action.resetFrom} → create_failed, then ` : ""}enqueue one shopify_order_update job for event ${action.eventId}`
    : `PLAN: ${action.kind.replaceAll("_", " ")}: ${action.reason}`,
  );
  return lines;
}
