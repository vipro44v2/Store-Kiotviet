import { query } from "@/lib/db/client";
import { ConflictError, RetryableError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { getShopifyOrderPaymentState } from "@/lib/shopify/orders";
import { getQueue } from "@/lib/queue/queues";
import { isRedisEnabled } from "@/lib/redis/client";
import { getEnv } from "@/lib/env";
import { applyInvoiceRecovery, planInvoiceRecovery } from "@/lib/recovery/kiotviet-invoice-recovery";
import { getInvoiceIndexHealth } from "@/lib/kiotviet/invoice-index";
import { lineAdjustmentAudit } from "./product-only-invoicing";
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
async function recordBlocked(orderId: string, reason: string, stage: string, audit?: Record<string, unknown>) {
  // `audit` (e.g. refunded-quantity adjustments) is merged into reconciliation so Admin shows it
  // for blocked orders too; nothing was sent to KiotViet.
  await query(
    `INSERT INTO invoice_mappings(shopify_order_id,status,source,last_error,failure_stage,reconciliation)
    VALUES($1,'blocked','auto',$2,$3,COALESCE($4::jsonb,'{}'::jsonb)) ON CONFLICT(shopify_order_id) DO UPDATE
    SET status='blocked',last_error=EXCLUDED.last_error,failure_stage=EXCLUDED.failure_stage,
      reconciliation=invoice_mappings.reconciliation || COALESCE($4::jsonb,'{}'::jsonb),updated_at=now()
    WHERE invoice_mappings.kiotviet_invoice_id IS NULL AND invoice_mappings.status IN ('blocked','failed')`,
    [orderId, reason.slice(0, 2000), stage, audit ? JSON.stringify(audit) : null],
  );
}

async function parkOrder(orderId: string, interval: "infinity" | "30 minutes") {
  await query(
    interval === "infinity"
      ? "UPDATE order_mappings SET invoice_check_at='infinity'::timestamptz WHERE shopify_order_id=$1"
      // Doubles per exhausted job of this order (max 24 h), so a persistent failure never polls every 30 minutes.
      : `UPDATE order_mappings SET invoice_check_at=now()+LEAST(interval '24 hours',interval '30 minutes'*power(2,LEAST(6,(
          SELECT count(*) FROM sync_jobs WHERE type='shopify_invoice_create' AND payload->>'entityId'=$1 AND status='failed' AND attempts>=max_attempts))))
        WHERE shopify_order_id=$1`,
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
export async function requestFulfillmentInvoice(orderId: string, options: { retryKey?: string; receivedAt?: string } = {}): Promise<InvoiceAdmission> {
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

  // retryKey admits one new job for an unchanged order (e.g. after the invoice index recovered).
  const triggerState = invoiceTriggerState(live, settingsVersion) + (options.retryKey ? `|${options.retryKey}` : "");
  const admitted = await query(
    `INSERT INTO sync_jobs(type,payload,priority,max_attempts)
    SELECT 'shopify_invoice_create',jsonb_build_object('entityId',$1::text,'triggerState',$3::text,'admittedAt',now(),'receivedAt',$4::text),'high',$2
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_jobs WHERE type='shopify_invoice_create' AND payload->>'entityId'=$1::text AND (
        status IN ('pending','processing')
        OR (status='failed' AND attempts < max_attempts)
        OR (status IN ('manual_review','completed','skipped') AND payload->>'triggerState'=$3::text)))
    ON CONFLICT ((payload->>'entityId')) WHERE type='shopify_invoice_create' AND status IN ('pending','processing') DO NOTHING
    RETURNING id`,
    [orderId, getEnv().JOB_MAX_ATTEMPTS, triggerState, options.receivedAt ?? null],
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
  // Existing invoices keep getting their stock pushed even if the trigger was disabled since.
  await retryInvoiceInventory();
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

export const INDEX_DEFERRED_STAGE = "invoice_index";

/**
 * Called by the invoice index job once the index is current: re-admits invoice
 * jobs that were deferred because duplicate detection was not yet possible.
 * Each deferral is re-admitted once (the stage is consumed when the job runs).
 */
export async function readmitIndexDeferredInvoices(currentAsOf: Date) {
  const rows = await query<{ shopify_order_id: string }>(
    `SELECT shopify_order_id FROM invoice_mappings WHERE status='blocked' AND failure_stage=$1 AND kiotviet_invoice_id IS NULL
    ORDER BY updated_at LIMIT 50`,
    [INDEX_DEFERRED_STAGE],
  );
  const results: Record<string, InvoiceAdmission> = {};
  for (const row of rows)
    results[row.shopify_order_id] = await requestFulfillmentInvoice(row.shopify_order_id, { retryKey: `index:${currentAsOf.toISOString()}` });
  if (rows.length)
    await log("info", "Invoice jobs re-admitted after invoice index recovery", {
      action: "invoice_index_readmitted", provider: "kiotviet", entityType: "invoice", results,
    });
  return results;
}

/** Structured log for each stage of the automatic invoice workflow. */
function stage(orderId: string, name: string, details: Record<string, unknown> = {}) {
  return log("info", `Invoice workflow: ${name}`, { action: `invoice_stage_${name}`, provider: "kiotviet", entityType: "invoice", entityId: orderId, ...details });
}

/**
 * Timestamps and durations of one invoice job, stored in reconciliation.timings.
 * latencyMs (trigger received → invoice verified) is the SLO measure.
 */
export class InvoiceTimer {
  readonly timings: Record<string, string | number> = {};
  private last = Date.now();
  constructor(private readonly origin?: string, admittedAt?: string) {
    if (origin) this.timings.triggerReceivedAt = origin;
    if (admittedAt) this.timings.admittedAt = admittedAt;
    this.mark("jobStarted");
    if (admittedAt) this.timings.queueMs = Math.max(0, Date.parse(String(this.timings.jobStartedAt)) - Date.parse(admittedAt));
  }
  mark(stageName: string) {
    const now = Date.now();
    this.timings[`${stageName}At`] = new Date(now).toISOString();
    this.timings[`${stageName}Ms`] = now - this.last;
    this.last = now;
    return this;
  }
  /** Latency from the trigger (webhook arrival, else admission, else job start) to now. */
  latency(name: string) {
    const start = Date.parse(String(this.timings.triggerReceivedAt ?? this.timings.admittedAt ?? this.timings.jobStartedAt));
    this.timings[name] = Date.now() - start;
  }
}

async function saveTimings(orderId: string, timer: InvoiceTimer) {
  await query("UPDATE invoice_mappings SET reconciliation=reconciliation || jsonb_build_object('timings',$2::jsonb) WHERE shopify_order_id=$1",
    [orderId, JSON.stringify(timer.timings)]);
}

export async function processFulfillmentInvoice(orderId: string, context: { receivedAt?: string; admittedAt?: string } = {}) {
  const timer = new InvoiceTimer(context.receivedAt, context.admittedAt);
  const { config, settingsVersion } = await orderSettings();
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
  timer.mark("triggerChecked");
  await stage(orderId, "trigger_ready", { trigger: config.invoiceCreationTrigger, productOnly: config.productOnlyInvoicing === true, financialStatus: live.displayFinancialStatus });
  // Without a usable index duplicate detection is inconclusive, unless the order has an
  // invoice-id floor (created by this app) that allows the short independent scan. Defer
  // cheaply otherwise (no Shopify/KiotViet reads, no attempt consumed); the index job re-admits it.
  const [index, [floor]] = await Promise.all([
    getInvoiceIndexHealth(),
    query<{ invoice_id_floor: string | null }>("SELECT invoice_id_floor::text FROM order_mappings WHERE shopify_order_id=$1", [orderId]),
  ]);
  if (!index.usable && !floor?.invoice_id_floor) {
    // An attempt that may already have sent its POST keeps the retry → link/review path.
    const [attempt] = await query<{ status: string }>("SELECT status FROM invoice_mappings WHERE shopify_order_id=$1", [orderId]);
    if (attempt && !["blocked", "failed"].includes(attempt.status))
      throw new RetryableError(`invoice_lookup_incomplete: invoice index not current; previous attempt is ${attempt.status}`);
    await recordBlocked(orderId, `invoice_index_not_ready: duplicate detection is inconclusive until the KiotViet invoice index is current (${index.scanned}/${index.total ?? "?"} indexed${index.lastError ? `; ${index.lastError}` : ""}); retried automatically`, INDEX_DEFERRED_STAGE);
    await stage(orderId, "deferred_for_index", { scanned: index.scanned, total: index.total, lastError: index.lastError });
    return;
  }
  await query(`UPDATE invoice_mappings SET failure_stage='invoice_index_retried',updated_at=now()
    WHERE shopify_order_id=$1 AND status='blocked' AND failure_stage=$2`, [orderId, INDEX_DEFERRED_STAGE]);
  // The live state read above is reused by the planner's staleness check.
  const plan = await planInvoiceRecovery(orderId, { live });
  timer.mark("planned");
  await stage(orderId, "planned", { plan: plan.action.kind, productOnly: plan.productOnly ?? null, duplicateLookup: plan.duplicateLookup ?? null,
    reasons: plan.action.kind === "blocked" ? plan.action.reasons : undefined, timings: timer.timings });
  if (plan.action.kind === "blocked") {
    const reason = plan.action.reasons.join("; ");
    if (TRANSIENT_REASONS.some((code) => reason.includes(code))) throw new RetryableError(reason);
    await recordBlocked(orderId, reason, "automatic_validation", plan.productOnly
      ? { invoicingMode: "product_only", productOnly: plan.productOnly }
      : plan.prepared?.adjustments ? { lineAdjustments: lineAdjustmentAudit(plan.prepared.adjustments) } : undefined);
    throw new ConflictError(reason);
  }
  if (plan.action.kind !== "none") {
    // Settings may have changed while remote validation was running. Shopify changes need no
    // second request: applyInvoiceRecovery re-reads the order and refuses a stale snapshot.
    if ((await orderSettings()).settingsVersion !== settingsVersion) throw new ConflictError("Invoice trigger changed during validation");
    const result = await applyInvoiceRecovery(plan);
    timer.mark("invoiceApplied");
    await stage(orderId, "applied", { applied: result.applied, status: result.status ?? null, invoiceCode: result.invoiceCode ?? null, message: result.message });
    if (!result.applied) {
      // An unknown POST outcome is never retried by sending again: the next run only
      // re-plans, which links the invoice or reports invoice_outcome_unknown.
      throw new RetryableError(result.message);
    }
    timer.latency("invoiceLatencyMs");
    await saveTimings(orderId, timer);
  }
  const [row] = await query<InvoiceRow>("SELECT * FROM invoice_mappings WHERE shopify_order_id=$1", [orderId]);
  if (!row?.kiotviet_invoice_id) throw new RetryableError("Invoice ID not yet verified; reconcile before retrying");
  await syncInvoiceInventory(row);
  timer.mark("inventorySynchronized");
  timer.latency("totalLatencyMs");
  if (plan.action.kind !== "none") await saveTimings(orderId, timer);
  if (row.status !== "created") throw new ConflictError("Invoice linked; stock movement or invoice checks require manual reconciliation");
}

/**
 * Pushes current KiotViet on-hand for the invoiced products to Shopify. Absolute
 * quantities (never a decrement), so running it again after a failure or a
 * verification retry cannot deduct Shopify stock twice. Independent of invoice
 * creation: retryInvoiceInventory() repairs failures without touching the invoice.
 */
export async function syncInvoiceInventory(row: InvoiceRow) {
  const orderId = row.shopify_order_id;
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
    await query(`UPDATE invoice_mappings SET reconciliation=(reconciliation - 'shopifyStockError' - 'stockRetryAt')
      || jsonb_build_object('shopifyStockSynchronized',true,'shopifyStockSynchronizedAt',now()),
      last_error=CASE WHEN failure_stage='shopify_inventory' THEN NULL ELSE last_error END,
      failure_stage=CASE WHEN failure_stage='shopify_inventory' THEN NULL ELSE failure_stage END WHERE shopify_order_id=$1`, [orderId]);
    await stage(orderId, "inventory_synchronized", { lines: row.reconciliation.expectedLines.length });
  } catch (error) {
    // Retried on its own with backoff (5 min × 2^attempts, max 6 h). A needs_review invoice
    // keeps its own error (e.g. the payment discrepancy); the stock error lives in reconciliation.
    await query(`UPDATE invoice_mappings SET reconciliation=reconciliation || jsonb_build_object(
        'shopifyStockSynchronized',false,'shopifyStockError',$2::text,
        'stockSyncAttempts',COALESCE((reconciliation->>'stockSyncAttempts')::int,0)+1,
        'stockRetryAt',now()+LEAST(interval '6 hours',interval '5 minutes'*power(2,LEAST(7,COALESCE((reconciliation->>'stockSyncAttempts')::int,0))))),
      last_error=CASE WHEN status='created' THEN $2 ELSE last_error END,
      failure_stage=CASE WHEN status='created' THEN 'shopify_inventory' ELSE failure_stage END,updated_at=now()
      WHERE shopify_order_id=$1`,
      [orderId, String(error).slice(0, 2000)]);
    throw error;
  }
}

/** Scheduler: re-pushes stock for invoices whose Shopify inventory sync failed or never ran. */
export async function retryInvoiceInventory(limit = 20) {
  const rows = await query<InvoiceRow>(`SELECT * FROM invoice_mappings WHERE kiotviet_invoice_id IS NOT NULL AND status IN ('created','needs_review')
    AND ((reconciliation->>'shopifyStockSynchronized'='false' AND COALESCE((reconciliation->>'stockRetryAt')::timestamptz,now())<=now())
      -- crashed between invoice and stock sync; only recent invoices, never a historical sweep
      OR (NOT reconciliation ? 'shopifyStockSynchronized' AND invoiced_at BETWEEN now()-interval '1 day' AND now()-interval '10 minutes'))
    ORDER BY updated_at LIMIT $1`, [limit]);
  const results: Record<string, "synced" | "failed"> = {};
  for (const row of rows) {
    try {
      await syncInvoiceInventory(row);
      results[row.shopify_order_id] = "synced";
    } catch {
      results[row.shopify_order_id] = "failed";
    }
  }
  if (rows.length) await log("info", "Invoice inventory synchronization retried", { action: "invoice_inventory_retry", provider: "shopify", results });
  return results;
}
