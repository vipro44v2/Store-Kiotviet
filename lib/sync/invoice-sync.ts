import type { PoolClient } from "pg";
import { query } from "@/lib/db/client";
import { ConflictError, RetryableError } from "@/lib/errors";
import { log } from "@/lib/logger";
import {
  findKiotVietInvoicesForOrder,
  getKiotVietInvoiceDetail,
  KIOTVIET_INVOICE_CANCELLED,
} from "@/lib/kiotviet/invoices";
import { getKiotVietProduct } from "@/lib/kiotviet/products";
import type { ShopifyOrderWebhook } from "@/types/shopify";
import type { OrderSettings } from "./default-branch";
import { evaluateInvoiceFinancials, type InvoiceFinancials } from "./invoice-financials";
import type { PreparedOrder } from "./order-sync";

/** How long a missing invoice may be "not visible yet" before it needs manual review. */
export const INVOICE_VERIFY_WINDOW_MS = 5 * 60_000;

export interface InvoiceRow {
  shopify_order_id: string;
  kiotviet_order_id: string | null;
  kiotviet_order_code: string | null;
  kiotviet_invoice_id: string | null;
  kiotviet_invoice_code: string | null;
  status: string;
  source: string;
  claim_token: string | null;
  claimed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string;
  expected_total: string | null;
  currency: string | null;
  reconciliation: InvoiceReconciliation | null;
}
export interface InvoiceReconciliation {
  branchId?: number;
  expectedLines?: Array<{ productId: number; sku?: string; quantity: number; price: number }>;
  stockBefore?: Record<string, number | null>;
  stockAfter?: Record<string, number | null>;
  stockVerified?: boolean;
  prepaid?: number;
  invoice?: { id: number; code: string; total: number | null; totalPayment: number | null; status: number | null; paymentRows?: Array<{ amount: number; method: string | null }> | null };
  checks?: Record<string, boolean>;
  [key: string]: unknown;
}

export const INVOICE_COLUMNS =
  "shopify_order_id,kiotviet_order_id::text,kiotviet_order_code,kiotviet_invoice_id::text,kiotviet_invoice_code,status,source,claim_token,claimed_at,created_at,updated_at::text,expected_total::text,currency,reconciliation";

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** onHand per product at the branch (null when KiotViet returns no row for it). */
export async function readBranchStock(productIds: number[], branchId: number) {
  const stock: Record<string, number | null> = {};
  for (const productId of [...new Set(productIds)]) {
    const product = await getKiotVietProduct(productId);
    const row = product.inventories?.find((inventory) => Number(inventory.branchId) === Number(branchId));
    stock[String(productId)] = row && row.onHand != null && Number.isFinite(Number(row.onHand)) ? Number(row.onHand) : null;
  }
  return stock;
}

/** Stock moved by exactly the invoiced quantities (other sales in between make this false). */
export function verifyStockMovement(reconciliation: InvoiceReconciliation, after: Record<string, number | null>) {
  const quantities = new Map<string, number>();
  for (const line of reconciliation.expectedLines ?? [])
    quantities.set(String(line.productId), (quantities.get(String(line.productId)) ?? 0) + line.quantity);
  return [...quantities].every(([productId, quantity]) => {
    const before = reconciliation.stockBefore?.[productId];
    return before !== null && before !== undefined && after[productId] === before - quantity;
  });
}

export async function hasEnabledLocationMapping(branchId: number) {
  const rows = await query("SELECT 1 FROM branch_location_mappings WHERE kiotviet_branch_id=$1 AND enabled=true", [branchId]);
  return rows.length > 0;
}

export interface AutoInvoiceDecision {
  enabled: boolean;
  request: boolean;
  financials?: InvoiceFinancials;
}

/** Only orders being created now are auto-invoiced; enabling the setting never touches existing orders. */
export function decideAutoInvoice(order: ShopifyOrderWebhook, prepared: PreparedOrder, settings: OrderSettings): AutoInvoiceDecision {
  if (settings.invoiceCreationTrigger !== undefined || settings.autoInvoice !== true) return { enabled: false, request: false };
  const financials = evaluateInvoiceFinancials(order, prepared, settings);
  return { enabled: true, request: financials.eligible, financials };
}

/** Runs inside the order claim transaction (no HTTP). Returns true when this job owns a pending invoice. */
export async function claimAutoInvoice(client: Pick<PoolClient, "query">, orderId: string, token: string, decision: AutoInvoiceDecision) {
  if (!decision.enabled) return false;
  const result = await client.query<{ status: string }>(
    `INSERT INTO invoice_mappings(shopify_order_id,status,source,claim_token,claimed_at,expected_total,currency,last_error,failure_stage)
    VALUES($1,$2,'auto',$3,now(),$4,$5,$6,$7)
    ON CONFLICT(shopify_order_id) DO UPDATE SET status=EXCLUDED.status,source='auto',claim_token=EXCLUDED.claim_token,
      claimed_at=now(),expected_total=EXCLUDED.expected_total,currency=EXCLUDED.currency,last_error=EXCLUDED.last_error,
      failure_stage=EXCLUDED.failure_stage,updated_at=now()
    WHERE invoice_mappings.kiotviet_invoice_id IS NULL AND invoice_mappings.status IN ('pending','failed','blocked')
    RETURNING status`,
    [
      orderId,
      decision.request ? "pending" : "blocked",
      token,
      decision.financials?.expectedPayment ?? null,
      decision.financials?.currency ?? null,
      decision.request ? null : decision.financials?.reasons.join("; ").slice(0, 2000) ?? null,
      decision.request ? null : "eligibility",
    ],
  );
  return result.rows[0]?.status === "pending";
}

/** Downgrades this job's pending invoice (the order is still created without one). */
export async function blockAutoInvoice(orderId: string, token: string, reason: string, stage: string) {
  await query(
    "UPDATE invoice_mappings SET status='blocked',claim_token=NULL,last_error=$3,failure_stage=$4,updated_at=now() WHERE shopify_order_id=$1 AND status='pending' AND claim_token=$2",
    [orderId, token, reason.slice(0, 2000), stage],
  );
}

/** Marks the invoice as sent together with the order request. Returns false when the claim was lost. */
export async function markAutoInvoiceSending(orderId: string, token: string, reconciliation: InvoiceReconciliation) {
  const rows = await query(
    "UPDATE invoice_mappings SET status='creating',reconciliation=$3,updated_at=now() WHERE shopify_order_id=$1 AND status='pending' AND claim_token=$2 RETURNING shopify_order_id",
    [orderId, token, JSON.stringify(reconciliation)],
  );
  return rows.length > 0;
}

/** The request was rejected, so neither the order nor its invoice exists. */
export async function failAutoInvoice(orderId: string, token: string, error: unknown) {
  await query(
    "UPDATE invoice_mappings SET status='failed',claim_token=NULL,last_error=$3,failure_stage='create_kiotviet_order',updated_at=now() WHERE shopify_order_id=$1 AND status IN ('pending','creating') AND claim_token=$2",
    [orderId, token, errorText(error)],
  );
}

export async function attachKiotVietOrderToInvoice(orderId: string, kiotVietOrder: { id: number | string; code: string }) {
  await query(
    "UPDATE invoice_mappings SET kiotviet_order_id=$2,kiotviet_order_code=$3,updated_at=now() WHERE shopify_order_id=$1 AND kiotviet_order_id IS NULL",
    [orderId, kiotVietOrder.id, kiotVietOrder.code],
  );
}

async function markNeedsReview(orderId: string, stage: string, message: string) {
  await query(
    "UPDATE invoice_mappings SET status='needs_review',claim_token=NULL,last_error=$3,failure_stage=$2,updated_at=now() WHERE shopify_order_id=$1 AND kiotviet_invoice_id IS NULL",
    [orderId, stage, message.slice(0, 2000)],
  );
}

/**
 * Saves a verified invoice. The UNIQUE kiotviet_invoice_id and the
 * `kiotviet_invoice_id IS NULL` guard make linking idempotent under concurrency.
 */
export async function finalizeInvoice(
  row: InvoiceRow,
  invoiceId: number,
  kiotVietOrder: { id: number; code: string },
  options: { prepaid?: number; source?: "auto" | "recovery" | "linked" } = {},
) {
  const detail = await getKiotVietInvoiceDetail(invoiceId);
  const reconciliation: InvoiceReconciliation = { ...(row.reconciliation ?? {}) };
  const expected = cents(row.expected_total);
  // An approved override may leave a balance (payment capped at what Shopify received).
  const expectedPayment = typeof reconciliation.expectedPaymentTotal === "number" ? cents(reconciliation.expectedPaymentTotal) : expected;
  // Product-Only (automatic): the invoice holds product lines only; excluded charges are
  // recorded in reconciliation.productOnly and never block or count as reconciled.
  const productOnly = reconciliation.invoicingMode === "product_only" && !reconciliation.manualOverride;
  const invoiceSurchargeCents = (detail.invoiceOrderSurcharges ?? []).reduce((sum, surcharge) => sum + cents(surcharge?.price), 0);
  const checks: Record<string, boolean> = {
    branch: Number(detail.branchId) === reconciliation.branchId,
    // Validation reasons must be absent, or each one explicitly approved by an admin override.
    financialValidation: !Array.isArray(reconciliation.validationReasons) || reconciliation.validationReasons.every((reason) =>
      Array.isArray(reconciliation.approvedWarnings) && reconciliation.approvedWarnings.includes(String(reason).split(":")[0].trim())),
    lines: Boolean(detail.invoiceDetails?.length && reconciliation.expectedLines?.length) &&
      detail.invoiceDetails!.length === reconciliation.expectedLines!.length &&
      reconciliation.expectedLines!.every(line => detail.invoiceDetails!.some(actual =>
        Number(actual.productId) === line.productId && Number(actual.quantity) === line.quantity &&
        cents(actual.price) === cents(line.price) && cents(actual.discount) === 0)),
    orderCode: detail.orderCode === kiotVietOrder.code,
    completed: Number(detail.status) === 1,
    // An order-linked invoice may report its total with or without the shipping surcharge;
    // the surcharge itself must then match the expected shipping exactly.
    total: row.expected_total !== null && (productOnly
      ? cents(detail.total) === expected && invoiceSurchargeCents === 0
      : cents(detail.total) === expected ||
        (cents(reconciliation.shippingTotal) > 0 && cents(detail.total) === expected - cents(reconciliation.shippingTotal) &&
          invoiceSurchargeCents === cents(reconciliation.shippingTotal))),
    // KiotViet may report the invoice payment alone or including the order's prepayment.
    // "Khách đã trả" must equal prepayment + new payment. A prepaid order is only invoiced
    // after sandbox evidence showed the invoice inherits the prepayment, so a value that
    // equals only the new payment means it was not inherited.
    payment: row.expected_total !== null && cents(detail.totalPayment) === expectedPayment,
    // Approved override differences (shipping, payment) are never reported as reconciled.
    financiallyReconciled: !(Array.isArray(reconciliation.remainingDifferences) && reconciliation.remainingDifferences.length > 0),
    // Actual payment rows must add up to "Khách đã trả". Without rows, a prepaid order's
    // payment cannot be verified.
    paymentRecords: Array.isArray(detail.payments)
      ? detail.payments.reduce((sum, row) => sum + cents(row?.amount), 0) === cents(detail.totalPayment)
      : cents(reconciliation.prepaid ?? 0) === 0,
  };
  reconciliation.invoice = {
    id: detail.id, code: detail.code,
    total: detail.total ?? null, totalPayment: detail.totalPayment ?? null, status: detail.status ?? null,
    paymentRows: Array.isArray(detail.payments) ? detail.payments.map((row) => ({ amount: Number(row?.amount ?? 0), method: row?.method ?? null })) : null,
  };
  if (productOnly) {
    // Kept visible for accounting, but not a creation gate in Product-Only mode.
    reconciliation.financiallyReconciled = checks.financiallyReconciled && (reconciliation.productOnly as { financiallyReconciled?: boolean } | undefined)?.financiallyReconciled === true;
    delete checks.financiallyReconciled;
  }
  reconciliation.checks = checks;
  if (reconciliation.branchId && reconciliation.expectedLines?.length) {
    try {
      reconciliation.stockAfter = await readBranchStock(reconciliation.expectedLines.map((line) => line.productId), reconciliation.branchId);
      reconciliation.stockVerified = verifyStockMovement(reconciliation, reconciliation.stockAfter);
    } catch (error) {
      reconciliation.stockVerified = false;
      reconciliation.stockReadError = errorText(error);
    }
  }
  const ok = Object.values(checks).every(Boolean) && reconciliation.stockVerified === true;
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (reconciliation.stockVerified !== true) failed.push("stock_movement_unverified");
  const updated = await query(
    `UPDATE invoice_mappings SET kiotviet_invoice_id=$2,kiotviet_invoice_code=$3,status=$4,source=COALESCE($8,source),reconciliation=$5,
      last_error=$6,failure_stage=$7,claim_token=NULL,invoiced_at=now(),updated_at=now(),
      kiotviet_order_id=COALESCE(kiotviet_order_id,$9),kiotviet_order_code=COALESCE(kiotviet_order_code,$10)
    WHERE shopify_order_id=$1 AND (kiotviet_invoice_id IS NULL OR kiotviet_invoice_id=$2) RETURNING shopify_order_id`,
    [
      row.shopify_order_id, detail.id, detail.code, ok ? "created" : "needs_review", JSON.stringify(reconciliation),
      ok ? null : `KiotViet invoice ${detail.code} does not match: ${failed.join(", ")}`, ok ? null : "verify_invoice",
      options.source ?? null, kiotVietOrder.id, kiotVietOrder.code,
    ],
  );
  await log(ok && reconciliation.stockVerified !== false ? "info" : "warn", "KiotViet invoice verified", {
    action: ok ? "kiotviet_invoice_created" : "kiotviet_invoice_mismatch",
    provider: "kiotviet", entityType: "invoice", entityId: row.shopify_order_id,
    kiotVietOrderId: kiotVietOrder.id, kiotVietInvoiceId: detail.id, checks,
    stockBefore: reconciliation.stockBefore, stockAfter: reconciliation.stockAfter, stockVerified: reconciliation.stockVerified,
    linked: updated.length > 0,
  });
  return { status: ok ? "created" : "needs_review", invoice: detail, reconciliation, linked: updated.length > 0 };
}

/**
 * Settles an invoice whose request was sent (or may have been) without a saved
 * ID, e.g. a timeout or a crash after KiotViet created it. Never creates one.
 */
export async function verifyOrderInvoice(orderId: string) {
  const [row] = await query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice_mappings WHERE shopify_order_id=$1`, [orderId]);
  if (!row || !["pending", "creating"].includes(row.status)) return { status: row?.status ?? "none" };
  const [mapping] = await query<{ kiotviet_order_id: string | null; kiotviet_order_code: string | null }>(
    "SELECT kiotviet_order_id::text,kiotviet_order_code FROM order_mappings WHERE shopify_order_id=$1",
    [orderId],
  );
  if (!mapping?.kiotviet_order_id || !mapping.kiotviet_order_code) return { status: row.status };
  const kiotVietOrder = { id: Number(mapping.kiotviet_order_id), code: mapping.kiotviet_order_code };
  const claimedAt = new Date(row.claimed_at ?? row.created_at).getTime();
  const lookup = await findKiotVietInvoicesForOrder(kiotVietOrder, new Date(claimedAt - 86_400_000));
  const active = lookup.invoices.filter((invoice) => Number(invoice.status) !== KIOTVIET_INVOICE_CANCELLED);
  if (active.length > 1) {
    const message = `KiotViet order ${kiotVietOrder.code} has ${active.length} invoices; manual review required`;
    await markNeedsReview(orderId, "verify_invoice", message);
    throw new ConflictError(message, { shopifyOrderId: orderId, mappingStatus: "duplicate_invoice" });
  }
  if (active.length === 1) return finalizeInvoice({ ...row, reconciliation: { ...row.reconciliation,
    ...(!lookup.complete ? { validationReasons: ["invoice_lookup_incomplete"] } : {}) } }, active[0].id, kiotVietOrder);
  if (!lookup.complete || Date.now() - claimedAt < INVOICE_VERIFY_WINDOW_MS)
    throw new RetryableError(`KiotViet invoice for order ${kiotVietOrder.code} is not visible yet`);
  const message = `KiotViet order ${kiotVietOrder.code} was created with makeInvoice but no invoice was found; manual review required (scripts/recover-kiotviet-invoice.ts)`;
  await markNeedsReview(orderId, "verify_invoice", message);
  throw new ConflictError(message, { shopifyOrderId: orderId, mappingStatus: "invoice_missing" });
}

/** Invoices this app created must not be read as "shipped" by the reverse status sync. */
export async function hasAppInvoice(client: Pick<PoolClient, "query">, shopifyOrderId: string) {
  const result = await client.query(
    "SELECT 1 FROM invoice_mappings WHERE shopify_order_id=$1 AND status IN ('pending','creating','created','needs_review')",
    [shopifyOrderId],
  );
  return Boolean(result.rows?.length);
}
