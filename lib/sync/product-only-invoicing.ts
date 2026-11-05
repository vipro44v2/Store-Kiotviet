import type { ShopifyOrderLineItem, ShopifyOrderWebhook } from "@/types/shopify";
import type { OrderSettings } from "./default-branch";
import { toCents } from "./order-line-items";

/**
 * Product-Only Invoicing.
 *
 * The KiotViet order and invoice record only product merchandise:
 *   invoiceTotal = Σ (discounted unit price × quantity)
 * Shipping, processing fees, tips and other non-product charges are never put
 * on the order or invoice and never folded into product prices. Shopify decides
 * whether the customer paid; the difference between what Shopify collected and
 * the merchandise invoice is recorded (reconciliation.productOnly) and is never
 * marked as financially reconciled.
 *
 * Each exclude flag names a category that may differ without blocking. A
 * category that is not excluded still blocks when present, because a
 * product-only invoice cannot carry it. Merchandise accuracy, quantities, SKU
 * mappings, seller, currency, duplicate invoices and payment safety always block.
 */
export interface ProductOnlyPolicy {
  enabled: boolean;
  paymentSource: "shopify";
  ignoreFinancialMismatch: boolean;
  excludeShipping: boolean;
  excludeProcessingFees: boolean;
  excludeOtherSurcharges: boolean;
  /** Exact prepayment may be invoiced before inheritance is proven (checked after creation). */
  allowUnverifiedPrepaymentInheritance: boolean;
  prepaymentExceedsInvoicePolicy: "block" | "manual_override";
}

export function productOnlyPolicy(settings: OrderSettings): ProductOnlyPolicy {
  const enabled = settings.productOnlyInvoicing === true;
  // Selecting the mode turns every exclusion on unless an admin explicitly turned one off.
  const flag = (value: unknown) => enabled && value !== false;
  return {
    enabled,
    paymentSource: "shopify",
    ignoreFinancialMismatch: flag(settings.ignoreFinancialMismatch),
    excludeShipping: flag(settings.excludeShipping),
    excludeProcessingFees: flag(settings.excludeProcessingFees),
    excludeOtherSurcharges: flag(settings.excludeOtherSurcharges),
    // Never implied by the mode: explicit opt-in plus a recorded acknowledgement.
    allowUnverifiedPrepaymentInheritance: enabled && settings.allowUnverifiedPrepaymentInheritance === true &&
      settings.acknowledgeUnverifiedPrepaymentRisk === true,
    prepaymentExceedsInvoicePolicy: settings.prepaymentExceedsInvoicePolicy === "manual_override" ? "manual_override" : "block",
  };
}

/** Amount actually discounted on this line (Shopify discount allocations, including order-level codes). */
export function lineDiscountCents(line: ShopifyOrderLineItem) {
  const field = `line item ${line.id}`;
  return Array.isArray(line.discount_allocations)
    ? line.discount_allocations.reduce((sum, allocation) => sum + toCents(allocation?.amount, field), 0)
    : toCents(line.total_discount, field);
}

/**
 * Discounted unit price in cents, or null when the line discount cannot be
 * spread over the quantity in whole cents (e.g. 10.00 off 3 units). KiotViet
 * lines are then not exact, so such an order is never invoiced automatically.
 */
export function discountedUnitPriceCents(line: ShopifyOrderLineItem, quantity: number) {
  const gross = toCents(line.price, `line item ${line.id}`) * quantity;
  const net = gross - lineDiscountCents(line);
  if (net < 0 || net % quantity !== 0) return null;
  return net / quantity;
}

/** Per Shopify product line: what was ordered, what a confirmed cancellation removed, and why. */
export interface LineAdjustment {
  lineItemId: string;
  sku: string | null;
  originalQuantity: number;
  /** All refunded units of this line (any restock type), refunds de-duplicated by id. */
  refundedQuantity: number;
  /** Units removed from the KiotViet order/invoice: confirmed cancelled refunds only. */
  excludedQuantity: number;
  remainingQuantity: number;
  /** Successfully fulfilled units, or null when Shopify did not provide fulfillments. */
  fulfilledQuantity: number | null;
  reason: "unchanged" | "cancelled_refund" | "requires_verification";
  detail: string;
  /** Shopify's refunded subtotal for the excluded units (after discounts), in cents. */
  excludedRefundSubtotalCents: number;
}

export interface RefundAdjustments {
  lines: Map<string, LineAdjustment>;
  /** Blocking reasons for refunds that cannot be tied to cancelled, never-shipped units. */
  ambiguous: string[];
}

const UNIT_CANCEL = new Set(["cancel"]);
const UNIT_NO_RESTOCK = new Set(["no_restock"]);

/**
 * Effective quantity per product line for Product-Only invoicing:
 *   effectiveQuantity = originalQuantity − confirmedCancelledRefundQuantity
 * Shopify's financial status says nothing about physical units, so only refund line
 * items count, and only when they are provably units that were never shipped:
 * - restock_type "cancel": Shopify removed unfulfilled units → excluded;
 * - restock_type "no_restock": excluded only if the fulfillments prove the refunded
 *   units were not shipped (fulfilled ≤ original − refunded); otherwise ambiguous;
 * - "return" / "legacy_restock" / missing type: delivered (or unknown) units →
 *   ambiguous; returns belong to the KiotViet return workflow, never silent removal;
 * - money refunded without refund line items never changes a quantity.
 * The base is always the original `quantity`; `current_quantity` must equal
 * original − refunded, otherwise (e.g. an order edit removed units) it is ambiguous.
 * Refunds are de-duplicated by id, so repeated refund events count once.
 * An ambiguous line keeps its original quantity; the reasons block invoicing.
 */
export function computeRefundAdjustments(
  order: Pick<ShopifyOrderWebhook, "refunds" | "fulfillments">,
  productLines: ShopifyOrderLineItem[],
): RefundAdjustments {
  const refundLines = new Map<string, Array<{ quantity: number; type: string; subtotalCents: number }>>();
  const seenRefunds = new Set<string>();
  for (const refund of order.refunds ?? []) {
    const refundKey = String(refund?.id ?? "");
    if (refundKey && seenRefunds.has(refundKey)) continue;
    if (refundKey) seenRefunds.add(refundKey);
    const seenItems = new Set<string>();
    for (const item of refund?.refund_line_items ?? []) {
      const quantity = Number(item?.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
      if (item.id != null) {
        if (seenItems.has(String(item.id))) continue;
        seenItems.add(String(item.id));
      }
      const key = String(item.line_item_id);
      const list = refundLines.get(key) ?? [];
      list.push({ quantity, type: String(item.restock_type ?? "").toLowerCase(), subtotalCents: toCents(item.subtotal, "refund subtotal") });
      refundLines.set(key, list);
    }
  }
  const fulfilled = order.fulfillments == null ? null : new Map<string, number>();
  for (const fulfillment of order.fulfillments ?? []) {
    if (String(fulfillment?.status ?? "").toLowerCase() !== "success") continue;
    for (const item of fulfillment.line_items ?? [])
      fulfilled!.set(String(item.id), (fulfilled!.get(String(item.id)) ?? 0) + Number(item.quantity ?? 0));
  }

  const lines = new Map<string, LineAdjustment>();
  const ambiguous: string[] = [];
  for (const line of productLines) {
    const key = String(line.id);
    const original = Number(line.quantity);
    const refunds = refundLines.get(key) ?? [];
    const sum = (filter: (type: string) => boolean) => refunds.filter((item) => filter(item.type)).reduce((total, item) => total + item.quantity, 0);
    const cancelled = sum((type) => UNIT_CANCEL.has(type));
    const noRestock = sum((type) => UNIT_NO_RESTOCK.has(type));
    const other = sum((type) => !UNIT_CANCEL.has(type) && !UNIT_NO_RESTOCK.has(type));
    const refunded = cancelled + noRestock + other;
    const fulfilledQuantity = fulfilled ? fulfilled.get(key) ?? 0 : null;
    const base = { lineItemId: key, sku: line.sku ?? null, originalQuantity: original, refundedQuantity: refunded, fulfilledQuantity };
    const keep = (reason: LineAdjustment["reason"], detail: string): LineAdjustment =>
      ({ ...base, excludedQuantity: 0, remainingQuantity: original, reason, detail, excludedRefundSubtotalCents: 0 });
    const problems: string[] = [];
    if (line.current_quantity != null && Number(line.current_quantity) !== original - refunded)
      problems.push(`current quantity ${line.current_quantity} is not ordered ${original} − refunded ${refunded} (units removed outside a refund, e.g. an order edit)`);
    if (refunded > original) problems.push(`refunded ${refunded} of ${original} ordered unit(s)`);
    if (other > 0) problems.push(`${other} unit(s) refunded as return/restock (delivered or unknown); use the KiotViet return workflow`);
    if (noRestock > 0 && fulfilledQuantity === null) problems.push(`${noRestock} unit(s) refunded without restock and no fulfillment data proves they were not shipped`);
    if (fulfilledQuantity !== null && fulfilledQuantity > original - cancelled - noRestock)
      problems.push(`${fulfilledQuantity} unit(s) fulfilled but only ${original - cancelled - noRestock} were not refunded: refunded units may have been shipped`);
    if (problems.length) {
      ambiguous.push(`refund_requires_verification: line item ${key}${line.sku ? ` (SKU ${line.sku})` : ""}: ${problems.join("; ")}`);
      lines.set(key, keep("requires_verification", problems.join("; ")));
      continue;
    }
    if (refunded === 0) {
      lines.set(key, keep("unchanged", "no refunded units"));
      continue;
    }
    const excluded = cancelled + noRestock;
    lines.set(key, {
      ...base, excludedQuantity: excluded, remainingQuantity: original - excluded, reason: "cancelled_refund",
      detail: `${excluded} unit(s) refunded before shipping (cancel ${cancelled}, no-restock ${noRestock}); fulfilled ${fulfilledQuantity ?? "n/a"}`,
      excludedRefundSubtotalCents: refunds.filter((item) => UNIT_CANCEL.has(item.type) || UNIT_NO_RESTOCK.has(item.type))
        .reduce((total, item) => total + item.subtotalCents, 0),
    });
  }
  return { lines, ambiguous };
}

/** Admin/audit view of the adjustments (only lines a refund touched). */
export function lineAdjustmentAudit(adjustments: RefundAdjustments | undefined) {
  return [...(adjustments?.lines.values() ?? [])]
    .filter((line) => line.refundedQuantity > 0 || line.reason !== "unchanged")
    .map(({ excludedRefundSubtotalCents, ...line }) => ({ ...line, excludedRefundSubtotal: excludedRefundSubtotalCents / 100 }));
}

export interface FinancialDifference {
  code: string;
  amount: number;
  message: string;
}

/** verified: sandbox evidence + accounting sign-off; unverified_accepted: proven per invoice after creation. */
export type PrepaymentPolicy = "verified" | "unverified_accepted";

export type ProductOnlyPaymentDecision =
  | { safe: true; additionalPayment: 0; expectedInvoicePayment: number; prepaymentPolicy: PrepaymentPolicy }
  | { safe: false; reason: string };

const money = (cents: number) => (cents / 100).toFixed(2);

/**
 * How the invoice may record payment without creating or duplicating money.
 * The invoice POST never carries an additional payment. KiotViet's carrying of
 * an order prepayment onto its invoice is undocumented, so the only automatic
 * case is the one verified on a sandbox (lib/kiotviet/prepayment-evidence.ts):
 * the order prepayment equals the invoice total exactly.
 */
export function productOnlyPaymentDecision(input: {
  prepaidCents: number;
  invoiceTotalCents: number;
  shopifyPaidCents: number;
  inheritanceVerified: boolean;
  inheritanceReason?: string;
  /** orders.allowUnverifiedPrepaymentInheritance (Product-Only, acknowledged). */
  allowUnverified?: boolean;
}): ProductOnlyPaymentDecision {
  const { prepaidCents, invoiceTotalCents, shopifyPaidCents } = input;
  if (prepaidCents === 0)
    return { safe: false, reason: `kiotviet_payment_missing: Shopify reports ${money(shopifyPaidCents)} paid but the KiotViet order records no payment; the invoice would be created unpaid and no payment is ever created automatically` };
  if (prepaidCents > invoiceTotalCents)
    return { safe: false, reason: `prepayment_exceeds_invoice: the KiotViet order records ${money(prepaidCents)} paid but the product-only invoice is ${money(invoiceTotalCents)}; how KiotViet carries the extra ${money(prepaidCents - invoiceTotalCents)} onto an invoice is unverified` };
  if (prepaidCents < invoiceTotalCents)
    return { safe: false, reason: `prepayment_below_invoice: the KiotViet order records ${money(prepaidCents)} paid but the product-only invoice is ${money(invoiceTotalCents)}; the invoice would remain partly unpaid` };
  if (!input.inheritanceVerified && !input.allowUnverified)
    return { safe: false, reason: `prepayment_inheritance_unverified: KiotViet already records ${money(prepaidCents)} paid on this order and it is undocumented whether an invoice created from it inherits that payment; ${input.inheritanceReason ?? "not verified"}` };
  // With the explicit policy the invoice is still sent without any payment; whether KiotViet
  // carried the prepayment is checked on the created invoice (finalizeInvoice → paymentVerification).
  return { safe: true, additionalPayment: 0, expectedInvoicePayment: prepaidCents / 100,
    prepaymentPolicy: input.inheritanceVerified ? "verified" : "unverified_accepted" };
}
