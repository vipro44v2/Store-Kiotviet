import { query } from "@/lib/db/client";
import { ConflictError, RetryableError } from "@/lib/errors";
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

async function settings() {
  return (await query<{ value: OrderSettings }>("SELECT value FROM system_settings WHERE key='orders'"))[0]?.value ?? {};
}

/** PostgreSQL outbox + unique order job: Redis failures cannot lose invoice admission. */
export async function requestFulfillmentInvoice(orderId: string) {
  const config = await settings();
  if (!config.invoiceCreationTrigger || config.invoiceCreationTrigger === "disabled") return;
  const [mapping] = await query("SELECT 1 FROM order_mappings WHERE shopify_order_id=$1 AND kiotviet_order_id IS NOT NULL", [orderId]);
  if (!mapping) return; // Normal order worker calls again after creation; scheduler also repairs missed events.
  const live = await getShopifyOrderPaymentState(orderId);
  if (!live || !["ready", "partial", "blocked"].includes(invoiceTriggerDecision(config, live))) return;
  await query(`INSERT INTO sync_jobs(type,payload,priority,max_attempts)
    VALUES('shopify_invoice_create',jsonb_build_object('entityId',$1::text),'high',$2)
    ON CONFLICT ((payload->>'entityId')) WHERE type='shopify_invoice_create' DO NOTHING`, [orderId, getEnv().JOB_MAX_ATTEMPTS]);
  await query("UPDATE order_mappings SET invoice_check_at='infinity'::timestamptz WHERE shopify_order_id=$1", [orderId]);
  await dispatchInvoiceOutbox();
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

/** Bounded rotating scan, only post-activation orders. No historical backfill. */
export async function reconcileFulfillmentInvoices() {
  await dispatchInvoiceOutbox();
  const config = await settings();
  if (!config.invoiceCreationTrigger || config.invoiceCreationTrigger === "disabled" || !config.invoiceTriggerEnabledAt) return;
  const rows = await query<{ shopify_order_id: string }>(`SELECT o.shopify_order_id FROM order_mappings o
    WHERE o.kiotviet_order_id IS NOT NULL AND o.created_at >= $1::timestamptz
    AND COALESCE(o.invoice_check_at,o.created_at) <= now()
    AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.type='shopify_invoice_create' AND j.payload->>'entityId'=o.shopify_order_id)
    ORDER BY COALESCE(o.invoice_check_at,o.created_at),o.shopify_order_id LIMIT 50`, [config.invoiceTriggerEnabledAt]);
  for (const row of rows) {
    await query("UPDATE order_mappings SET invoice_check_at=now()+interval '5 minutes' WHERE shopify_order_id=$1", [row.shopify_order_id]);
    await requestFulfillmentInvoice(row.shopify_order_id);
  }
}

export async function processFulfillmentInvoice(orderId: string) {
  const config = await settings();
  const live = await getShopifyOrderPaymentState(orderId);
  if (!live) throw new ConflictError("Shopify order missing");
  const decision = invoiceTriggerDecision(config, live);
  if (["disabled", "historical"].includes(decision)) return;
  if (decision === "waiting") throw new RetryableError("Waiting for current Shopify fulfillment/payment state");
  if (decision !== "ready") {
    await recordReview(orderId, `${decision}: only fully fulfilled, non-cancelled paid orders can be invoiced`);
    throw new ConflictError(`Invoice requires manual review: ${decision}`);
  }
  const plan = await planInvoiceRecovery(orderId);
  if (plan.action.kind === "blocked") {
    const reason = plan.action.reasons.join("; ");
    if (reason.includes("order_not_synced") || reason.includes("invoice_in_flight")) throw new RetryableError(reason);
    await recordReview(orderId, reason);
    throw new ConflictError(reason);
  }
  if (plan.action.kind !== "none") {
    // Settings may have changed while remote validation was running.
    const latest = await getShopifyOrderPaymentState(orderId);
    if (!latest || invoiceTriggerDecision(await settings(), latest) !== "ready") throw new ConflictError("Invoice trigger changed during validation");
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

async function recordReview(orderId: string, reason: string) {
  await query(`INSERT INTO invoice_mappings(shopify_order_id,status,source,last_error,failure_stage)
    VALUES($1,'needs_review','auto',$2,'automatic_validation') ON CONFLICT(shopify_order_id) DO UPDATE
    SET status='needs_review',last_error=$2,updated_at=now() WHERE invoice_mappings.kiotviet_invoice_id IS NULL`, [orderId, reason]);
}
