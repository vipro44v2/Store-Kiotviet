import { getInvoiceOrder } from "@/lib/shopify/invoice-order";
import { randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import {
  createKiotVietInvoice,
  findKiotVietInvoicesForOrder,
  KIOTVIET_INVOICE_CANCELLED,
  type KiotVietInvoiceInput,
} from "@/lib/kiotviet/invoices";
import { getKiotVietOrder, type KiotVietOrderDetail } from "@/lib/kiotviet/orders";
import { getShopifyOrderPaymentState } from "@/lib/shopify/orders";
import { normalizeSku } from "@/lib/sync/mappings";
import type { OrderSettings } from "@/lib/sync/default-branch";
import { evaluateInvoiceFinancials, type InvoiceFinancials } from "@/lib/sync/invoice-financials";
import {
  finalizeInvoice,
  hasEnabledLocationMapping,
  INVOICE_COLUMNS,
  INVOICE_VERIFY_WINDOW_MS,
  readBranchStock,
  type InvoiceReconciliation,
  type InvoiceRow,
} from "@/lib/sync/invoice-sync";
import { isDefiniteRejection, prepareOrderForKiotViet, type PreparedOrder } from "@/lib/sync/order-sync";
import { mappingsRepository } from "@/repositories/mappings";
import type { ShopifyOrderWebhook } from "@/types/shopify";
import { RecoveryArgsError } from "./shopify-order-recovery";
import { PREPAYMENT_EVIDENCE_KEY, prepaymentInheritanceStatus } from "@/lib/kiotviet/prepayment-evidence";

export const INVOICE_RECOVERY_USAGE = `Usage:
  recover-kiotviet-invoice.ts --list
  recover-kiotviet-invoice.ts <shopifyOrderId> [<shopifyOrderId> ...] [--apply]
  recover-kiotviet-invoice.ts <shopifyOrderId> --reset-uncertain --apply
Positional arguments are Shopify order IDs of orders already synchronized to KiotViet.`;

export type InvoiceRecoveryArgs =
  | { mode: "list" }
  | { mode: "recover"; shopifyOrderIds: string[]; apply: boolean; resetUncertain: boolean };

export function parseInvoiceRecoveryArgs(argv: string[]): InvoiceRecoveryArgs {
  let list = false, apply = false, resetUncertain = false;
  const ids: string[] = [];
  for (const arg of argv) {
    if (arg === "--list") list = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--reset-uncertain") resetUncertain = true;
    else if (arg.startsWith("-")) throw new RecoveryArgsError(`Unknown option ${arg}`);
    else {
      const id = arg.startsWith("gid://shopify/Order/") ? arg.slice("gid://shopify/Order/".length) : arg;
      if (!/^[1-9]\d{0,19}$/.test(id))
        throw new RecoveryArgsError(`Invalid Shopify order ID "${arg}": expected a positive integer such as 7108106289336`);
      ids.push(id);
    }
  }
  if (list) {
    if (ids.length || apply || resetUncertain)
      throw new RecoveryArgsError("--list is read-only and cannot be combined with order IDs or other options");
    return { mode: "list" };
  }
  const shopifyOrderIds = [...new Set(ids)];
  if (!shopifyOrderIds.length) throw new RecoveryArgsError("Pass --list or at least one Shopify order ID");
  if (resetUncertain && shopifyOrderIds.length !== 1)
    throw new RecoveryArgsError("--reset-uncertain requires exactly one Shopify order ID");
  return { mode: "recover", shopifyOrderIds, apply, resetUncertain };
}

interface OrderMapping {
  shopify_order_id: string;
  shopify_order_number: string | null;
  kiotviet_order_id: string | null;
  kiotviet_order_code: string | null;
  status: string | null;
}

export type InvoiceRecoveryAction =
  | { kind: "none"; reason: string }
  | { kind: "blocked"; reasons: string[] }
  | { kind: "link"; invoice: { id: number; code: string } }
  | { kind: "reset_uncertain" }
  | { kind: "create_invoice"; input: KiotVietInvoiceInput };

export interface InvoiceRecoveryPlan {
  shopifyOrderId: string;
  shopifySnapshot?: ShopifyOrderWebhook;
  mapping?: OrderMapping;
  invoiceRow?: InvoiceRow;
  kiotVietOrder?: KiotVietOrderDetail;
  prepared?: PreparedOrder;
  financials?: InvoiceFinancials;
  validationReasons?: string[];
  expectedTotal?: number;
  prepaid?: number;
  currency?: string | null;
  expectedLines?: Array<{ productId: number; sku: string; quantity: number; price: number }>;
  stockNow?: Record<string, number | null>;
  /** Exact invoice a manual override would send; only built when no hard block returned earlier. */
  proposal?: InvoiceProposal;
  action: InvoiceRecoveryAction;
}

export interface InvoiceProposal {
  input: KiotVietInvoiceInput;
  /** What the customer was charged in Shopify. */
  shopify: { merchandise: number; shipping: number; excludedFees: number; total: number; paidForGoods: number };
  /** What the KiotViet invoice will contain: the existing order lines and surcharges, unchanged. */
  invoice: { merchandise: number; surcharges: number; total: number };
  /** Payment recorded in KiotViet once the invoice exists (prepayment carried + additional payment). */
  payment: { existingPrepayment: number; additionalPayment: number; totalRecorded: number; overpayment: number; remainingBalance: number };
  /** Differences that stay after invoicing; an invoice with any of them is never "reconciled". */
  remainingDifferences: Array<{ code: string; amount: number; message: string }>;
  reconciled: boolean;
  /** Conditions that disable submission even with approved warnings. */
  blockers: string[];
}

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Compares the stored webhook with Shopify's live order so a stale payload is never invoiced. */
async function staleness(orderId: string, payload: ShopifyOrderWebhook) {
  const live = await getShopifyOrderPaymentState(orderId);
  if (!live) return ["shopify_order_missing: the order no longer exists in Shopify"];
  const reasons: string[] = [];
  if (live.updatedAt && payload.updated_at !== live.updatedAt) reasons.push("stale_payload: order changed during validation");
  if (Boolean(live.cancelledAt) !== Boolean(payload.cancelled_at)) reasons.push("stale_payload: cancellation differs from Shopify");
  if (live.displayFinancialStatus.toLowerCase() !== String(payload.financial_status ?? "").toLowerCase())
    reasons.push(`stale_payload: Shopify financial status is ${live.displayFinancialStatus}, stored webhook says ${payload.financial_status}`);
  if (live.currencyCode.toUpperCase() !== String(payload.currency ?? "").toUpperCase())
    reasons.push(`stale_payload: Shopify currency is ${live.currencyCode}, stored webhook says ${payload.currency ?? "none"}`);
  if (live.refunds.length !== (payload.refunds ?? []).length)
    reasons.push(`stale_payload: Shopify has ${live.refunds.length} refund(s), stored webhook has ${(payload.refunds ?? []).length}`);
  if (cents(live.totalPriceSet.shopMoney.amount) !== cents(payload.total_price))
    reasons.push("stale_payload: Shopify order total differs from the stored webhook");
  return reasons;
}

/**
 * Read-only (SELECTs, KiotViet and Shopify GETs). Never creates a KiotViet
 * order; an invoice is only planned for an existing, fully reconciled order.
 */
export async function planInvoiceRecovery(orderId: string, options: { resetUncertain?: boolean } = {}): Promise<InvoiceRecoveryPlan> {
  const [mapping] = await query<OrderMapping>(
    "SELECT shopify_order_id,shopify_order_number,kiotviet_order_id::text,kiotviet_order_code,status FROM order_mappings WHERE shopify_order_id=$1",
    [orderId],
  );
  const plan: InvoiceRecoveryPlan = { shopifyOrderId: orderId, mapping, action: { kind: "blocked", reasons: [] } };
  const block = (...reasons: string[]) => ({ ...plan, action: { kind: "blocked" as const, reasons } });
  if (!mapping?.kiotviet_order_id || !mapping.kiotviet_order_code)
    return block("order_not_synced: no KiotViet order is linked; use scripts/recover-shopify-order-sync.ts first");
  if (mapping.status === "cancelled") return block("order_cancelled: the KiotViet order mapping is cancelled");
  const [invoiceRow] = await query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice_mappings WHERE shopify_order_id=$1`, [orderId]);
  plan.invoiceRow = invoiceRow;
  if (invoiceRow?.kiotviet_invoice_id)
    return { ...plan, action: { kind: "none", reason: `already invoiced: ${invoiceRow.kiotviet_invoice_code} (${invoiceRow.kiotviet_invoice_id})` } };

  const kiotVietOrder = await getKiotVietOrder(Number(mapping.kiotviet_order_id));
  plan.kiotVietOrder = kiotVietOrder;
  if (kiotVietOrder?.code !== mapping.kiotviet_order_code)
    return block(`order_mismatch: KiotViet order ${mapping.kiotviet_order_id} has code ${kiotVietOrder?.code}, mapping says ${mapping.kiotviet_order_code}`);

  // Validation runs before the invoice lookup so a linked invoice is also checked.
  const reasons: string[] = [];
  plan.validationReasons = reasons;
  const [settingsRow] = await query<{ value: OrderSettings }>("SELECT value FROM system_settings WHERE key='orders'");
  const settings = settingsRow?.value ?? {};
  const event = { payload: await getInvoiceOrder(orderId) };
  plan.shopifySnapshot = event.payload;
  if (!event) reasons.push("no_shopify_payload: no stored Shopify order webhook");
  else {
    reasons.push(...(await staleness(orderId, event.payload)));
    if (["partial", "partially_fulfilled"].includes(event.payload.fulfillment_status ?? "")) reasons.push("partial_fulfillment: manual review required");
    try {
      plan.prepared = prepareOrderForKiotViet(event.payload, settings);
      plan.financials = evaluateInvoiceFinancials(event.payload, plan.prepared, settings);
      reasons.push(...plan.financials.reasons);
      plan.expectedTotal = plan.financials.expectedPayment;
      plan.currency = plan.financials.currency;
    } catch (error) {
      reasons.push(`invalid_order: ${errorText(error)}`);
    }
  }

  if (kiotVietOrder.status === 4) reasons.push("kiotviet_order_cancelled: the KiotViet order is cancelled");
  const configuredBranch = Number(settings.defaultBranchId);
  if (!Number.isSafeInteger(configuredBranch) || configuredBranch <= 0)
    reasons.push("branch_not_configured: set orders.defaultBranchId");
  else if (Number(kiotVietOrder.branchId) !== configuredBranch)
    reasons.push(`branch_mismatch: KiotViet order is in branch ${kiotVietOrder.branchId}, configured branch is ${configuredBranch}`);
  if (!(await hasEnabledLocationMapping(Number(kiotVietOrder.branchId))))
    reasons.push(`branch_location_unmapped: KiotViet branch ${kiotVietOrder.branchId} has no enabled Shopify location mapping`);

  // Every physical line must match the existing KiotViet order exactly (product, quantity, price).
  if (plan.prepared) {
    const expected = new Map<number, { sku: string; quantity: number; price: number }>();
    for (const { sku, quantity, price } of plan.prepared.lines) {
      const owners = (await mappingsRepository.findBySku(normalizeSku(sku))).filter((row) => row.sync_status !== "archived");
      const productId = Number(owners[0]?.kiotviet_product_id);
      if (owners.length !== 1 || !Number.isSafeInteger(productId) || productId <= 0) {
        reasons.push(`sku_unmapped: SKU ${sku} has ${owners.length} active product mapping(s)`);
        continue;
      }
      const current = expected.get(productId);
      if (current && current.price !== price) reasons.push(`price_conflict: SKU ${sku} appears with different prices`);
      expected.set(productId, { sku, quantity: (current?.quantity ?? 0) + quantity, price });
    }
    const actual = new Map<number, { quantity: number; price: number; discount: number }>();
    for (const detail of kiotVietOrder.orderDetails ?? []) {
      const current = actual.get(Number(detail.productId));
      actual.set(Number(detail.productId), {
        quantity: (current?.quantity ?? 0) + Number(detail.quantity), price: Number(detail.price),
        discount: (current?.discount ?? 0) + Number(detail.discount ?? 0),
      });
    }
    for (const [productId, line] of expected) {
      const found = actual.get(productId);
      if (!found) reasons.push(`line_missing: KiotViet order has no line for SKU ${line.sku} (product ${productId})`);
      else {
        if (found.quantity !== line.quantity) reasons.push(`quantity_mismatch: SKU ${line.sku} is ${found.quantity} in KiotViet, ${line.quantity} in Shopify`);
        if (cents(found.price) !== cents(line.price)) reasons.push(`price_mismatch: SKU ${line.sku} costs ${found.price} in KiotViet, ${line.price} in Shopify`);
        if (found.discount) reasons.push(`unsupported_discount: KiotViet line for SKU ${line.sku} has a discount`);
      }
    }
    for (const productId of actual.keys())
      if (!expected.has(productId)) reasons.push(`extra_line: KiotViet order has product ${productId} that is not a Shopify physical line`);
    plan.expectedLines = [...expected].map(([productId, line]) => ({ productId, ...line }));
    // Shipping must already be on the KiotViet order as the configured surcharge;
    // the invoice never invents it and product prices never absorb it.
    const shippingCents = cents(plan.financials?.shippingTotal ?? 0);
    const surchargeId = Number(settings.shippingSurcharge?.id);
    let orderShippingCents = 0;
    for (const surcharge of kiotVietOrder.invoiceOrderSurcharges ?? []) {
      if (Number(surcharge?.surchargeId) === surchargeId) orderShippingCents += cents(surcharge?.price);
      else reasons.push(`unexpected_surcharge: KiotViet order has surcharge ${surcharge?.surchargeId} (${surcharge?.surchargeName ?? ""}) that is not Shopify shipping`);
    }
    if (shippingCents > 0 && orderShippingCents === 0)
      reasons.push(`shipping_not_on_kiotviet_order: Shopify charged ${shippingCents / 100} shipping but the KiotViet order has no shipping surcharge (orders created before orders.shippingSurcharge was configured); invoice it manually in KiotViet`);
    else if (orderShippingCents !== shippingCents)
      reasons.push(`shipping_mismatch: KiotViet order shipping surcharge ${orderShippingCents / 100} differs from Shopify shipping ${shippingCents / 100}`);
    // KiotViet's order `total` may or may not include surcharges (undocumented); both are
    // consistent once the surcharge itself was verified above.
    if (plan.expectedTotal !== undefined &&
        ![cents(plan.expectedTotal), cents(plan.expectedTotal) - orderShippingCents].includes(cents(kiotVietOrder.total)))
      reasons.push(`total_mismatch: KiotViet order total ${kiotVietOrder.total} differs from expected ${plan.expectedTotal}`);
    plan.stockNow = await readBranchStock([...expected.keys()], Number(kiotVietOrder.branchId));
    if (Object.values(plan.stockNow).some(value => value === null || !Number.isFinite(value))) reasons.push("branch_stock_unavailable: cannot establish stock before invoicing");
  }

  // Payment already recorded on the order (prepayment) must not be recorded again.
  const prepaidCents = kiotVietOrder.totalPayment !== undefined && kiotVietOrder.totalPayment !== null
    ? cents(kiotVietOrder.totalPayment)
    : (kiotVietOrder.payments ?? []).reduce((sum, payment) => sum + cents(payment?.amount), 0);
  plan.prepaid = prepaidCents / 100;
  if (!Number.isFinite(prepaidCents) || prepaidCents < 0 || (kiotVietOrder.totalPayment == null && !Array.isArray(kiotVietOrder.payments)))
    reasons.push("payment_unknown: KiotViet prepayment is missing or invalid");
  if (kiotVietOrder.totalPayment != null && kiotVietOrder.payments?.length &&
      kiotVietOrder.payments.reduce((sum, payment) => sum + cents(payment.amount), 0) !== prepaidCents)
    reasons.push("payment_mismatch: KiotViet payment rows disagree with totalPayment");
  if (plan.expectedTotal !== undefined && prepaidCents > cents(plan.expectedTotal))
    reasons.push(`overpaid: KiotViet order already records ${plan.prepaid} paid, more than ${plan.expectedTotal}`);
  // Undocumented KiotViet behavior: never invoice a prepaid order (automatically or by
  // override) without sandbox evidence that the invoice inherits the prepayment.
  if (prepaidCents > 0) {
    const [evidenceRow] = await query<{ value: unknown }>("SELECT value FROM system_settings WHERE key=$1", [PREPAYMENT_EVIDENCE_KEY]);
    const inheritance = prepaymentInheritanceStatus(evidenceRow?.value, settings.invoicePrepaymentVerified);
    if (!inheritance.verified)
      reasons.push(`prepayment_inheritance_unverified: KiotViet already records ${plan.prepaid} paid on this order and it is undocumented whether an invoice created from it inherits that payment; ${inheritance.reason}`);
  }

  // Never issue an invoice before proving none exists.
  const lookup = await findKiotVietInvoicesForOrder({ id: kiotVietOrder.id, code: kiotVietOrder.code, branchId: kiotVietOrder.branchId, customerId: kiotVietOrder.customerId }, invoiceSearchStart(kiotVietOrder));
  const active = lookup.invoices.filter((invoice) => Number(invoice.status) !== KIOTVIET_INVOICE_CANCELLED);
  if (active.length > 1) return block(`duplicate_invoices: KiotViet order ${kiotVietOrder.code} has ${active.length} invoices (${active.map((invoice) => invoice.code).join(", ")})`);
  if (!lookup.complete && active.length === 1) reasons.push("invoice_lookup_incomplete: invoice uniqueness cannot be fully verified");
  if (active.length === 1) return { ...plan, action: { kind: "link", invoice: { id: active[0].id, code: active[0].code } } };
  if (!lookup.complete) return block(...reasons, `invoice_lookup_incomplete: could not prove that no invoice exists for this KiotViet order (${lookup.indexError ?? "index not current"}); build the index with scripts/build-kiotviet-invoice-index.ts`);
  if (lookup.invoices.length)
    return block(`cancelled_invoice_exists: ${lookup.invoices.map((invoice) => invoice.code).join(", ")}; review in KiotViet before invoicing again`);
  if (kiotVietOrder.status === 3) reasons.push("kiotviet_order_completed: the KiotViet order is completed but has no invoice");

  const claimedAt = invoiceRow ? new Date(invoiceRow.claimed_at ?? invoiceRow.created_at).getTime() : 0;
  // 'pending' = claimed, no POST sent yet: in flight while fresh, safely reclaimable once stale.
  if (invoiceRow?.status === "pending" && Date.now() - claimedAt < INVOICE_VERIFY_WINDOW_MS)
    return block("invoice_in_flight: another attempt claimed this order less than 5 minutes ago");
  // 'creating' / 'needs_review' = a POST may have been sent: never treated as unsent.
  if (invoiceRow && ["creating", "needs_review"].includes(invoiceRow.status)) {
    if (Date.now() - claimedAt < INVOICE_VERIFY_WINDOW_MS)
      return block(`invoice_in_flight: a previous attempt (${invoiceRow.status}) is less than 5 minutes old`);
    if (!options.resetUncertain)
      return block(`invoice_outcome_unknown: a previous attempt is ${invoiceRow.status} and no invoice is visible; check KiotViet, then run with --reset-uncertain --apply`);
    return { ...plan, action: { kind: "reset_uncertain" } };
  }
  if (plan.prepared && plan.expectedLines) plan.proposal = buildInvoiceProposal(plan.prepared, plan.financials, kiotVietOrder, prepaidCents, settings);
  if (reasons.length) return block(...reasons);
  return {
    ...plan,
    action: {
      kind: "create_invoice",
      input: {
        branchId: Number(kiotVietOrder.branchId),
        orderId: kiotVietOrder.id,
        ...(kiotVietOrder.customerId ? { customerId: Number(kiotVietOrder.customerId) } : {}),
        discount: 0,
        totalPayment: (cents(plan.expectedTotal) - prepaidCents) / 100,
        method: "Transfer",
        invoiceDetails: (kiotVietOrder.orderDetails ?? []).map((detail) => ({
          productId: Number(detail.productId), productCode: String(detail.productCode ?? ""),
          productName: String(detail.productName ?? detail.productCode ?? ""),
          quantity: Number(detail.quantity), price: Number(detail.price), discount: 0,
        })),
      },
    },
  };
}

/**
 * The invoice the admin override would send: exactly the existing KiotViet
 * order lines and surcharges. Payment is capped at what Shopify actually
 * received for goods, minus what KiotViet already recorded, so a payment is
 * never invented or recorded twice. Product prices are never changed.
 */
function buildInvoiceProposal(prepared: PreparedOrder, financials: InvoiceFinancials | undefined, kiotVietOrder: KiotVietOrderDetail, prepaidCents: number, settings: OrderSettings): InvoiceProposal {
  const invoiceDetails = (kiotVietOrder.orderDetails ?? []).map((detail) => ({
    productId: Number(detail.productId), productCode: String(detail.productCode ?? ""),
    productName: String(detail.productName ?? detail.productCode ?? ""),
    quantity: Number(detail.quantity), price: Number(detail.price), discount: 0,
  }));
  const blockers: string[] = [];
  if (!invoiceDetails.length || invoiceDetails.some((detail) => !Number.isSafeInteger(detail.quantity) || detail.quantity <= 0 || !Number.isFinite(detail.price) || detail.price < 0))
    blockers.push("invalid_kiotviet_lines: the KiotViet order lines are missing or invalid");
  const detailsCents = invoiceDetails.reduce((sum, detail) => sum + cents(detail.price) * detail.quantity, 0);
  const surchargeCents = (kiotVietOrder.invoiceOrderSurcharges ?? []).reduce((sum, surcharge) => sum + cents(surcharge?.price), 0);
  if (surchargeCents > 0 && settings.shippingSurcharge?.invoiceInheritsFromOrder !== true)
    blockers.push("surcharge_inheritance_unverified: confirm in KiotViet that an invoice created from an order keeps its surcharges");
  const invoiceTotalCents = detailsCents + surchargeCents;
  const paidCents = cents(prepared.amounts.adjustedTotal);
  const additionalCents = Math.max(0, Math.min(invoiceTotalCents, paidCents) - prepaidCents);
  const recordedCents = prepaidCents + additionalCents;
  const shopifyMerchandiseCents = cents(financials?.merchandiseTotal ?? 0);
  const shopifyShippingCents = cents(financials?.shippingTotal ?? 0);
  const money = (value: number) => (value / 100).toFixed(2);
  const differences: InvoiceProposal["remainingDifferences"] = [];
  const add = (code: string, amountCents: number, message: string) => {
    if (amountCents !== 0) differences.push({ code, amount: amountCents / 100, message });
  };
  add("merchandise_difference", shopifyMerchandiseCents - detailsCents,
    `Shopify merchandise ${money(shopifyMerchandiseCents)} vs KiotViet invoice lines ${money(detailsCents)}`);
  add("shipping_unrecorded", shopifyShippingCents - surchargeCents,
    `Shopify shipping ${money(shopifyShippingCents)} vs KiotViet invoice surcharges ${money(surchargeCents)}`);
  add("overpayment", Math.max(0, recordedCents - invoiceTotalCents),
    `KiotViet will record ${money(recordedCents)} paid for an invoice of ${money(invoiceTotalCents)}`);
  add("remaining_balance", Math.max(0, invoiceTotalCents - recordedCents),
    `The invoice will remain ${money(invoiceTotalCents - recordedCents)} unpaid`);
  add("payment_not_recorded", paidCents - recordedCents,
    `Customer paid ${money(paidCents)} in Shopify (excluding fees); KiotViet will record ${money(recordedCents)}`);
  return {
    input: {
      branchId: Number(kiotVietOrder.branchId),
      orderId: kiotVietOrder.id,
      ...(kiotVietOrder.customerId ? { customerId: Number(kiotVietOrder.customerId) } : {}),
      discount: 0,
      totalPayment: additionalCents / 100,
      method: "Transfer",
      invoiceDetails,
    },
    shopify: {
      merchandise: shopifyMerchandiseCents / 100, shipping: shopifyShippingCents / 100,
      excludedFees: prepared.amounts.excludedFeeTotal, total: prepared.amounts.shopifyTotal, paidForGoods: paidCents / 100,
    },
    invoice: { merchandise: detailsCents / 100, surcharges: surchargeCents / 100, total: invoiceTotalCents / 100 },
    payment: {
      existingPrepayment: prepaidCents / 100, additionalPayment: additionalCents / 100, totalRecorded: recordedCents / 100,
      overpayment: Math.max(0, recordedCents - invoiceTotalCents) / 100, remainingBalance: Math.max(0, invoiceTotalCents - recordedCents) / 100,
    },
    remainingDifferences: differences,
    reconciled: differences.length === 0,
    blockers,
  };
}

function invoiceSearchStart(order: KiotVietOrderDetail) {
  return new Date(new Date(order.createdDate ?? order.purchaseDate ?? Date.now()).getTime() - 86_400_000);
}

function reconciliationFor(plan: InvoiceRecoveryPlan, extra: Record<string, unknown> = {}): InvoiceReconciliation {
  return { ...plan.invoiceRow?.reconciliation, ...extra, branchId: Number(plan.kiotVietOrder?.branchId), expectedLines: plan.expectedLines, prepaid: plan.prepaid, shippingTotal: plan.financials?.shippingTotal ?? 0, validationReasons: plan.validationReasons };
}

/**
 * Applies exactly the planned action. Claims go through the advisory lock and
 * the unique invoice_mappings constraints; the planned row version must still
 * be current, so concurrent runs or workers make this a no-op.
 */
export async function applyInvoiceRecovery(
  plan: InvoiceRecoveryPlan,
  options: { reconciliation?: Record<string, unknown> } = {},
): Promise<{ applied: boolean; message: string; invoiceCode?: string; status?: string }> {
  const orderId = plan.shopifyOrderId, action = plan.action, kiotVietOrder = plan.kiotVietOrder;
  const plannedVersion = plan.invoiceRow?.updated_at ?? null;
  if (action.kind === "reset_uncertain") {
    const rows = await query(
      "UPDATE invoice_mappings SET status='failed',claim_token=NULL,failure_stage='manual_reset',last_error='Operator confirmed no invoice exists',updated_at=now() WHERE shopify_order_id=$1 AND kiotviet_invoice_id IS NULL AND updated_at=$2::timestamptz RETURNING shopify_order_id",
      [orderId, plannedVersion],
    );
    return rows.length
      ? { applied: true, message: "Reset to failed. Run the dry run again to plan the invoice." }
      : { applied: false, message: "Invoice state changed since the dry run; nothing changed" };
  }
  if ((action.kind !== "link" && action.kind !== "create_invoice") || !kiotVietOrder)
    return { applied: false, message: `Nothing to apply (${action.kind})` };

  const token = randomUUID();
  const claimed = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`kiotviet-invoice:${orderId}`]);
    const result = await client.query<InvoiceRow>(
      `INSERT INTO invoice_mappings(shopify_order_id,kiotviet_order_id,kiotviet_order_code,status,source,claim_token,claimed_at,expected_total,currency,reconciliation)
      VALUES($1,$2,$3,'pending',$4,$5,now(),$6,$7,$8)
      ON CONFLICT(shopify_order_id) DO UPDATE SET kiotviet_order_id=EXCLUDED.kiotviet_order_id,kiotviet_order_code=EXCLUDED.kiotviet_order_code,
        status='pending',source=EXCLUDED.source,claim_token=EXCLUDED.claim_token,claimed_at=now(),expected_total=EXCLUDED.expected_total,
        currency=EXCLUDED.currency,reconciliation=EXCLUDED.reconciliation,last_error=NULL,failure_stage=NULL,updated_at=now()
      WHERE invoice_mappings.kiotviet_invoice_id IS NULL AND invoice_mappings.updated_at IS NOT DISTINCT FROM $9::timestamptz
        AND ($9::timestamptz IS NOT NULL) AND (invoice_mappings.status IN ('failed','blocked') OR $4='linked'
          OR (invoice_mappings.status='pending' AND invoice_mappings.claimed_at < now()-interval '5 minutes'))
      RETURNING ${INVOICE_COLUMNS}`,
      [orderId, kiotVietOrder.id, kiotVietOrder.code, action.kind === "link" ? "linked" : "recovery", token,
        plan.expectedTotal ?? null, plan.currency ?? null, JSON.stringify(reconciliationFor(plan, options.reconciliation)), plannedVersion],
    );
    return result.rows[0];
  });
  if (!claimed) return { applied: false, message: "Invoice state changed since the dry run (another run or worker); nothing changed" };
  const ref = { id: kiotVietOrder.id, code: kiotVietOrder.code, branchId: kiotVietOrder.branchId, customerId: kiotVietOrder.customerId };

  /**
   * Before the POST nothing has been sent, so every exit releases the claim as
   * definitely unsent: 'failed' (safe to retry) or 'blocked' (needs review, but
   * never "outcome unknown"). Only the POST itself can leave 'creating'.
   */
  const release = async (status: "failed" | "blocked", stage: string, message: string) => {
    await query(
      "UPDATE invoice_mappings SET status=$4,claim_token=NULL,last_error=$3,failure_stage=$5,updated_at=now() WHERE shopify_order_id=$1 AND claim_token=$2 AND status='pending'",
      [orderId, token, message.slice(0, 2000), status, stage],
    );
    return { applied: false, message };
  };

  if (action.kind === "link") {
    try {
      const result = await finalizeInvoice(claimed, action.invoice.id, ref, { prepaid: plan.prepaid, source: "linked" });
      return { applied: result.linked, message: `Linked existing invoice ${action.invoice.code}: ${result.status}` };
    } catch (error) {
      await release("failed", "link_invoice", `Linking invoice ${action.invoice.code} failed; nothing sent: ${errorText(error)}`);
      throw error;
    }
  }

  let reconciliation: InvoiceReconciliation;
  try {
    // Fresh stock reading and a last look for an invoice created since the plan (e.g. by staff).
    reconciliation = {
      ...reconciliationFor(plan, options.reconciliation),
      stockBefore: await readBranchStock((plan.expectedLines ?? []).map((line) => line.productId), Number(kiotVietOrder.branchId)),
    };
    const recheck = await findKiotVietInvoicesForOrder(ref, invoiceSearchStart(kiotVietOrder));
    if (!recheck.complete)
      return await release("failed", "pre_post_lookup", `invoice_lookup_incomplete: could not re-confirm that no invoice exists (${recheck.indexError ?? "index not current"}); nothing sent, safe to retry`);
    const appeared = recheck.invoices.filter((invoice) => Number(invoice.status) !== KIOTVIET_INVOICE_CANCELLED);
    if (appeared.length === 1) {
      const result = await finalizeInvoice({ ...claimed, reconciliation }, appeared[0].id, ref, { prepaid: plan.prepaid, source: "linked" });
      return { applied: result.linked, message: `An invoice appeared since the dry run; linked ${appeared[0].code}: ${result.status}` };
    }
    if (appeared.length > 1)
      return await release("blocked", "pre_post_lookup", `duplicate_invoices: KiotViet order ${ref.code} now has ${appeared.length} invoices; nothing sent`);
    if (recheck.invoices.length)
      return await release("blocked", "pre_post_lookup", `cancelled_invoice_exists: ${recheck.invoices.map((invoice) => invoice.code).join(", ")}; nothing sent`);
    const fresh = await getInvoiceOrder(orderId);
    const freshOrder = await getKiotVietOrder(kiotVietOrder.id);
    if (JSON.stringify(fresh) !== JSON.stringify(plan.shopifySnapshot) || JSON.stringify(freshOrder) !== JSON.stringify(kiotVietOrder))
      return await release("failed", "pre_post_staleness", "stale_payload: order changed during validation; nothing sent; run the dry run again");
  } catch (error) {
    await release("failed", "pre_post", `Pre-send check failed; nothing sent: ${errorText(error)}`);
    throw error;
  }
  const marked = await query(
    "UPDATE invoice_mappings SET status='creating',reconciliation=$3,updated_at=now() WHERE shopify_order_id=$1 AND status='pending' AND claim_token=$2 RETURNING shopify_order_id",
    [orderId, token, JSON.stringify(reconciliation)],
  );
  if (!marked.length) return { applied: false, message: "Claim lost before sending; nothing sent" };

  let created: { id: number; code: string };
  try {
    created = await createKiotVietInvoice(action.input);
  } catch (error) {
    const rejected = isDefiniteRejection(error);
    await query(
      rejected
        ? "UPDATE invoice_mappings SET status='failed',claim_token=NULL,last_error=$3,failure_stage='create_invoice',updated_at=now() WHERE shopify_order_id=$1 AND claim_token=$2"
        : "UPDATE invoice_mappings SET last_error=$3,failure_stage='create_invoice',updated_at=now() WHERE shopify_order_id=$1 AND claim_token=$2",
      [orderId, token, errorText(error).slice(0, 2000)],
    );
    return {
      applied: false,
      message: rejected
        ? `KiotViet rejected the invoice: ${errorText(error)}`
        : `Outcome unknown (${errorText(error)}); NOT resent. Run the dry run again in 5 minutes to link or review it.`,
    };
  }
  const result = await finalizeInvoice({ ...claimed, reconciliation }, created.id, ref, { prepaid: plan.prepaid, source: "recovery" });
  return {
    applied: true,
    invoiceCode: created.code,
    status: result.status,
    message: `Created invoice ${created.code}: ${result.status}; stock ${result.reconciliation.stockVerified !== true ? "moved unexpectedly (review)" : "verified"}`,
  };
}

export function describeInvoiceRecoveryPlan(plan: InvoiceRecoveryPlan): string[] {
  const lines = [`== Shopify order ${plan.shopifyOrderId}${plan.mapping?.shopify_order_number ? ` (${plan.mapping.shopify_order_number})` : ""}`];
  if (plan.kiotVietOrder)
    lines.push(`KiotViet order ${plan.kiotVietOrder.code} (${plan.kiotVietOrder.id}): status=${plan.kiotVietOrder.status} branch=${plan.kiotVietOrder.branchId} total=${plan.kiotVietOrder.total} prepaid=${plan.prepaid}`);
  if (plan.invoiceRow) lines.push(`local invoice state: ${plan.invoiceRow.status}${plan.invoiceRow.kiotviet_invoice_code ? ` ${plan.invoiceRow.kiotviet_invoice_code}` : ""}`);
  for (const fee of plan.prepared?.fees ?? [])
    lines.push(`excluded fee: line ${fee.line.id} "${fee.line.title ?? fee.line.name ?? ""}" amount=${fee.chargedCents / 100}`);
  if (plan.prepared)
    lines.push(`amounts: shopify_total=${plan.prepared.amounts.shopifyTotal} excluded_fees=${plan.prepared.amounts.excludedFeeTotal} expected_invoice_total=${plan.expectedTotal} currency=${plan.currency ?? "?"}`);
  for (const line of plan.expectedLines ?? [])
    lines.push(`line: SKU ${line.sku} product ${line.productId} qty=${line.quantity} price=${line.price} stock_now=${plan.stockNow?.[String(line.productId)] ?? "?"}`);
  for (const reason of plan.validationReasons ?? []) lines.push(`validation: ${reason}`);
  const action = plan.action;
  if (action.kind === "blocked") lines.push("PLAN: blocked", ...action.reasons.map((reason) => `  - ${reason}`));
  else if (action.kind === "none") lines.push(`PLAN: nothing to do (${action.reason})`);
  else if (action.kind === "link") lines.push(`PLAN: link existing KiotViet invoice ${action.invoice.code}; no invoice is created`);
  else if (action.kind === "reset_uncertain") lines.push("PLAN: mark the unknown previous attempt as failed (no invoice exists in KiotViet)");
  else lines.push(`PLAN: create one invoice for existing KiotViet order ${plan.kiotVietOrder?.code}: total ${plan.expectedTotal}, additional payment ${action.input.totalPayment}, ${action.input.invoiceDetails.length} line(s)`);
  return lines;
}
