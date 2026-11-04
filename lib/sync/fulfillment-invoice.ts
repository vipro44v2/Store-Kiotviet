import { query } from "@/lib/db/client";
import { ConflictError, RetryableError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { getShopifyOrderPaymentState } from "@/lib/shopify/orders";
import { getQueue } from "@/lib/queue/queues";
import { isRedisEnabled } from "@/lib/redis/client";
import { getEnv } from "@/lib/env";
import { applyInvoiceRecovery, planInvoiceRecovery } from "@/lib/recovery/kiotviet-invoice-recovery";
import { getSyncSettings } from "./sync-settings";
import { syncInventoryNotification } from "./inventory-sync";
import type { OrderSettings } from "./default-branch";
import type { InvoiceRow } from "./invoice-sync";

export function invoiceTriggerDecision(settings: OrderSettings, live: {
  createdAt?: string; cancelledAt?: string | null; displayFinancialStatus: string; displayFulfillmentStatus?: string;
}) {
  if (!settings.invoiceCreationTrigger || settings.invoiceCreationTrigger === "disabled") return "disabled";
  if (!live.createdAt || !settings.invoiceTriggerEnabledAt ||
      !(Date.parse(live.createdAt) >= Date.parse(settings.invoiceTriggerEnabledAt))) return "historical";
  if (live.cancelledAt || live.displayFinancialStatus === "REFUNDED") return "blocked";
  if (live.displayFulfillmentStatus === "PARTIALLY_FULFILLED") return "partial";
  if (!["PAID", "PARTIALLY_REFUNDED"].includes(live.displayFinancialStatus)) return "waiting";
  return settings.invoiceCreationTrigger === "shopify_paid" || live.displayFulfillmentStatus === "FULFILLED" ? "ready" : "waiting";
}

async function orderSettings() {
  const [row] = await query<{ value: OrderSettings; updated_at: string | null }>(
    "SELECT value,updated_at::text FROM system_settings WHERE key='orders'",
  );
  return { config: row?.value ?? {}, settingsVersion: row?.updated_at ?? "" };
}

/**
 * Identifies what an invoice job evaluated: the Shopify order version and the
 * settings version. A job that ended in manual review is not repeated for the
 * same state, but a new fulfillment (partial → full), payment, refund or a
 * settings fix (e.g. currency configured) admits a new job.
 */
export function invoiceTriggerState(live: { updatedAt?: string }, settingsVersion: string) {
  return `${live.updatedAt ?? ""}|${settingsVersion}`;
}

/**
 * Not eligible (yet). 'blocked' can be re-evaluated; 'needs_review' is reserved
 * for uncertain remote results and is never overwritten here.
 */
async function recordBlocked(orderId: string, reason: string, stage: string) {
  await query(
    `INSERT INTO invoice_mappings(shopify_order_id,status,source,last_error,failure_stage)
    VALUES($1,'blocked','auto',$2,$3) ON CONFLICT(shopify_order_id) DO UPDATE
    SET status='blocked',last_error=EXCLUDED.last_error,failure_stage=EXCLUDED.failure_stage,updated_at=now()
    WHERE invoice_mappings.kiotviet_invoice_id IS NULL AND invoice_mappings.status IN ('blocked','failed')`,
    [orderId, reason.slice(0, 2000), stage],
  );
}

async function parkOrder(orderId: string, interval: "infinity" | "30 minutes") {
  await query(
    interval === "infinity"
      ? "UPDATE order_mappings SET invoice_check_at='infinity'::timestamptz WHERE shopify_order_id=$1"
      : "UPDATE order_mappings SET invoice_check_at=now()+interval '30 minutes' WHERE shopify_order_id=$1",
    [orderId],
  );
}

export type InvoiceAdmission =
  | "disabled" | "not_synced" | "invoiced" | "missing" | "historical" | "blocked"
  | "partial" | "waiting" | "admitted" | "already_admitted";

/**
 * Called for Shopify fulfillment/order events and by the rescan. Admits at most
 * one active invoice job per order (PostgreSQL outbox; Redis loss cannot drop it).
 */
export async function requestFulfillmentInvoice(orderId: string): Promise<InvoiceAdmission> {
  const { config, settingsVersion } = await orderSettings();
  if (!config.invoiceCreationTrigger || config.invoiceCreationTrigger === "disabled") return "disabled";
  const [mapping] = await query<{ invoice_id: string | null }>(
    `SELECT i.kiotviet_invoice_id::text AS invoice_id FROM order_mappings o
    LEFT JOIN invoice_mappings i ON i.shopify_order_id=o.shopify_order_id
    WHERE o.shopify_order_id=$1 AND o.kiotviet_order_id IS NOT NULL`,
    [orderId],
  );
  if (!mapping) return "not_synced"; // The order worker calls again after creation; the rescan repairs misses.
  if (mapping.invoice_id) {
    await parkOrder(orderId, "infinity");
    return "invoiced";
  }
  const live = await getShopifyOrderPaymentState(orderId);
  if (!live) return "missing";
  const decision = invoiceTriggerDecision(config, live);
  if (decision === "disabled") return "disabled";
  if (decision === "historical") {
    // Orders created before the trigger was enabled are never backfilled.
    await parkOrder(orderId, "infinity");
    return "historical";
  }
  if (decision === "blocked") {
    await recordBlocked(orderId, "cancelled_or_refunded: cancelled or fully refunded orders are never invoiced", "fulfillment_trigger");
    await parkOrder(orderId, "infinity");
    return "blocked";
  }
  if (decision === "partial") {
    // Not terminal: the full fulfillment (webhook or rescan) admits the job later.
    await recordBlocked(orderId, "partial_fulfillment: waiting for the Shopify order to be fully fulfilled", "fulfillment_trigger");
    return "partial";
  }
  if (decision === "waiting") return "waiting";

  const triggerState = invoiceTriggerState(live, settingsVersion);
  const admitted = await query(
    `INSERT INTO sync_jobs(type,payload,priority,max_attempts)
    SELECT 'shopify_invoice_create',jsonb_build_object('entityId',$1::text,'triggerState',$3::text),'high',$2
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_jobs WHERE type='shopify_invoice_create' AND payload->>'entityId'=$1::text AND (
        status IN ('pending','processing')
        OR (status='failed' AND attempts < max_attempts)
        OR (status IN ('manual_review','completed','skipped') AND payload->>'triggerState'=$3::text)))
    ON CONFLICT ((payload->>'entityId')) WHERE type='shopify_invoice_create' AND status IN ('pending','processing') DO NOTHING
    RETURNING id`,
    [orderId, getEnv().JOB_MAX_ATTEMPTS, triggerState],
  );
  await parkOrder(orderId, "30 minutes");
  await dispatchInvoiceOutbox();
  return admitted.length ? "admitted" : "already_admitted";
}

export async function dispatchInvoiceOutbox() {
  if (!isRedisEnabled()) return; // Durable pending rows remain until the worker/Redis is enabled.
  const rows = await query<{ id: string; payload: { entityId: string } }>(`SELECT id,payload FROM sync_jobs
    WHERE type='shopify_invoice_create' AND queue_job_id IS NULL AND status='pending' ORDER BY created_at LIMIT 50`);
  for (const row of rows) {
    const jobId = `invoice-${row.id}`;
    await getQueue("sync").add("shopify_invoice_create", { ...row.payload, auditJobId: row.id }, {
      jobId, attempts: getEnv().JOB_MAX_ATTEMPTS, backoff: { type: "custom" }, removeOnComplete: false, removeOnFail: false,
    });
    await query("UPDATE sync_jobs SET queue_job_id=$2 WHERE id=$1 AND queue_job_id IS NULL", [row.id, jobId]);
  }
}

/** Bounded rotating rescan of post-activation orders without an invoice. No historical backfill. */
export async function reconcileFulfillmentInvoices() {
  await dispatchInvoiceOutbox();
  const { config } = await orderSettings();
  if (!config.invoiceCreationTrigger || config.invoiceCreationTrigger === "disabled" || !config.invoiceTriggerEnabledAt) return;
  const rows = await query<{ shopify_order_id: string }>(`SELECT o.shopify_order_id FROM order_mappings o
    WHERE o.kiotviet_order_id IS NOT NULL AND o.created_at >= $1::timestamptz
    AND COALESCE(o.invoice_check_at,o.created_at) <= now()
    AND NOT EXISTS(SELECT 1 FROM invoice_mappings i WHERE i.shopify_order_id=o.shopify_order_id AND i.kiotviet_invoice_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.type='shopify_invoice_create' AND j.payload->>'entityId'=o.shopify_order_id
      AND (j.status IN ('pending','processing') OR (j.status='failed' AND j.attempts < j.max_attempts)))
    ORDER BY COALESCE(o.invoice_check_at,o.created_at),o.shopify_order_id LIMIT 50`, [config.invoiceTriggerEnabledAt]);
  for (const row of rows) {
    await query("UPDATE order_mappings SET invoice_check_at=now()+interval '5 minutes' WHERE shopify_order_id=$1", [row.shopify_order_id]);
    await requestFulfillmentInvoice(row.shopify_order_id);
  }
}

/** Remote-state reasons that resolve by themselves; retried instead of manual review. */
const TRANSIENT_REASONS = ["order_not_synced", "invoice_in_flight", "invoice_lookup_incomplete"];

export async function processFulfillmentInvoice(orderId: string) {
  const { config } = await orderSettings();
  const live = await getShopifyOrderPaymentState(orderId);
  if (!live) throw new ConflictError("Shopify order missing");
  const decision = invoiceTriggerDecision(config, live);
  if (decision === "disabled" || decision === "historical") return;
  if (decision === "waiting") {
    // State went back (e.g. a fulfillment was cancelled). The next event or rescan re-admits it.
    await log("info", "Invoice trigger no longer satisfied", { action: "invoice_trigger_not_ready", provider: "kiotviet", entityType: "invoice", entityId: orderId });
    return;
  }
  if (decision === "partial") {
    await recordBlocked(orderId, "partial_fulfillment: waiting for the Shopify order to be fully fulfilled", "fulfillment_trigger");
    return;
  }
  if (decision === "blocked") {
    await recordBlocked(orderId, "cancelled_or_refunded: cancelled or fully refunded orders are never invoiced", "fulfillment_trigger");
    return;
  }
  const plan = await planInvoiceRecovery(orderId);
  if (plan.action.kind === "blocked") {
    const reason = plan.action.reasons.join("; ");
    if (TRANSIENT_REASONS.some((code) => reason.includes(code))) throw new RetryableError(reason);
    await recordBlocked(orderId, reason, "automatic_validation");
    throw new ConflictError(reason);
  }
  if (plan.action.kind !== "none") {
    // Settings may have changed while remote validation was running.
    const latest = await getShopifyOrderPaymentState(orderId);
    if (!latest || invoiceTriggerDecision((await orderSettings()).config, latest) !== "ready") throw new ConflictError("Invoice trigger changed during validation");
    const result = await applyInvoiceRecovery(plan);
    if (!result.applied) throw new RetryableError(result.message);
  }
  const [row] = await query<InvoiceRow>("SELECT * FROM invoice_mappings WHERE shopify_order_id=$1", [orderId]);
  if (!row?.kiotviet_invoice_id) throw new RetryableError("Invoice ID not yet verified; reconcile before retrying");
  try {
    const sync = await getSyncSettings();
    if (!sync.kiotVietInventoryToShopify) throw new ConflictError("Invoice exists; Shopify inventory synchronization is disabled");
    if (!row.reconciliation?.expectedLines?.length) throw new ConflictError("Invoice exists; inventory lines are missing");
    for (const line of row.reconciliation.expectedLines) {
      const result = await syncInventoryNotification({ ProductId: line.productId, ProductCode: line.sku ?? "",
        BranchId: Number(row.reconciliation.branchId), OnHand: 0, ProductName: "", BranchName: "", Cost: 0, Reserved: 0 }, undefined,
      { refreshFromKiotViet: true, conflictStrategy: sync.inventoryConflictStrategy });
      if (result?.status !== "synced") throw new ConflictError("Invoice exists; inventory synchronization requires review");
    }
    await query("UPDATE invoice_mappings SET reconciliation=reconciliation || '{\"shopifyStockSynchronized\":true}'::jsonb WHERE shopify_order_id=$1", [orderId]);
  } catch (error) {
    await query(`UPDATE invoice_mappings SET reconciliation=reconciliation || $2::jsonb,
      last_error=$3,failure_stage='shopify_inventory',updated_at=now() WHERE shopify_order_id=$1`,
      [orderId, JSON.stringify({ shopifyStockSynchronized: false, shopifyStockError: String(error) }), String(error)]);
    throw error;
  }
  if (row.status !== "created") throw new ConflictError("Invoice linked; stock movement or invoice checks require manual reconciliation");
}
