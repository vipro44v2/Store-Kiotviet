import type { ShopifyOrderWebhook } from "@/types/shopify";
import type { OrderSettings } from "./default-branch";
import { shippingChargedCents, toCents } from "./order-line-items";
import type { PreparedOrder } from "./order-sync";

export interface InvoiceFinancials {
  eligible: boolean;
  /** Why invoicing is blocked; each entry starts with a stable code. */
  reasons: string[];
  currency: string | null;
  /** Σ unit price × quantity of the physical (non-fee) lines sent to KiotViet. */
  merchandiseTotal: number;
  /** Shipping the customer paid, recorded as the configured KiotViet surcharge. */
  shippingTotal: number;
  /** Amount the KiotViet invoice must record as paid. */
  expectedPayment: number;
  refundedTotal: number;
}

const money = (cents: number) => (cents / 100).toFixed(2);

/**
 * Decides whether a KiotViet invoice can be issued for this order without
 * guessing. Anything the KiotViet payload cannot represent exactly (line
 * discounts, shipping, added taxes, tips, product refunds, another currency)
 * blocks invoicing for manual review instead of producing wrong totals.
 */
export function evaluateInvoiceFinancials(
  order: ShopifyOrderWebhook,
  prepared: PreparedOrder,
  settings: OrderSettings,
): InvoiceFinancials {
  const reasons: string[] = [];
  const taxesIncluded = order.taxes_included === true;
  const feeLineIds = new Set(prepared.fees.map((fee) => String(fee.line.id)));
  const feeCents = Math.round(prepared.amounts.excludedFeeTotal * 100);

  if (order.cancelled_at) reasons.push("order_cancelled: the Shopify order is cancelled");
  const financialStatus = order.financial_status ?? "unknown";
  if (financialStatus !== "paid" && financialStatus !== "partially_refunded")
    reasons.push(`not_paid: financial_status is ${financialStatus}`);

  const configured = typeof settings.kiotVietCurrency === "string" ? settings.kiotVietCurrency.trim().toUpperCase() : "";
  const currency = order.currency ? order.currency.toUpperCase() : null;
  if (!configured) reasons.push("kiotviet_currency_not_configured: set orders.kiotVietCurrency to the currency KiotViet prices are recorded in");
  else if (!currency) reasons.push("order_currency_missing: the Shopify order has no currency");
  else if (currency !== configured)
    reasons.push(`currency_mismatch: Shopify order is in ${currency} but KiotViet is configured for ${configured}; currency conversion is not supported`);

  let merchandiseCents = 0;
  for (const { line, quantity } of prepared.lines) {
    merchandiseCents += toCents(line.price, `line item ${line.id}`) * quantity;
    const discount = Array.isArray(line.discount_allocations)
      ? line.discount_allocations.reduce((sum, allocation) => sum + toCents(allocation?.amount, "discount"), 0)
      : toCents(line.total_discount, "discount");
    if (discount > 0) reasons.push(`unsupported_discount: line item ${line.id} has a discount of ${money(discount)}`);
    const tax = (line.tax_lines ?? []).reduce((sum, taxLine) => sum + toCents(taxLine?.price, "tax"), 0);
    if (!taxesIncluded && tax > 0) reasons.push(`unsupported_tax: line item ${line.id} has ${money(tax)} tax added on top of its price`);
  }
  // Shipping is recorded only as the configured KiotViet surcharge ("thu khác"),
  // never folded into product prices.
  const shippingCents = shippingChargedCents(order);
  const surcharge = settings.shippingSurcharge;
  if (shippingCents > 0) {
    if (!surcharge?.id || !surcharge.code)
      reasons.push(`unsupported_shipping: shipping of ${money(shippingCents)} needs orders.shippingSurcharge (a KiotViet "thu khác") to be recorded`);
    else if (surcharge.invoiceInheritsFromOrder !== true)
      reasons.push(`shipping_unverified: confirm in KiotViet that an invoice created from an order keeps its surcharge, then set orders.shippingSurcharge.invoiceInheritsFromOrder`);
  }
  for (const shipping of order.shipping_lines ?? []) {
    const tax = (shipping?.tax_lines ?? []).reduce((sum, taxLine) => sum + toCents(taxLine?.price, "tax"), 0);
    if (!taxesIncluded && tax > 0) reasons.push(`unsupported_tax: shipping has ${money(tax)} tax`);
  }
  const tip = toCents(order.total_tip_received, "tip");
  if (tip > 0) reasons.push(`unsupported_tip: tip of ${money(tip)}`);

  const adjustedCents = Math.round(prepared.amounts.adjustedTotal * 100);
  if (adjustedCents !== merchandiseCents + shippingCents)
    reasons.push(`amount_mismatch: Shopify total ${prepared.amounts.shopifyTotal.toFixed(2)} − fees ${money(feeCents)} = ${money(adjustedCents)} but KiotViet lines ${money(merchandiseCents)} + shipping ${money(shippingCents)} = ${money(merchandiseCents + shippingCents)}`);

  // Refunds: only a refund of the processing fee itself keeps the invoice exact.
  let refundedCents = 0;
  const refunds = order.refunds ?? [];
  if (financialStatus === "partially_refunded" && !refunds.length)
    reasons.push("refund_details_missing: partially_refunded order without refund details");
  for (const refund of refunds) {
    const refundLines = refund.refund_line_items ?? [];
    const amount = (refund.transactions ?? [])
      .filter((transaction) => transaction?.kind === "refund" && transaction?.status === "success")
      .reduce((sum, transaction) => sum + toCents(transaction?.amount, "refund"), 0);
    refundedCents += amount;
    const productLines = refundLines.filter((item) => Number(item.quantity) > 0 && !feeLineIds.has(String(item.line_item_id)));
    if (productLines.length)
      reasons.push(`refund_affects_products: refund ${refund.id} refunds line item(s) ${productLines.map((item) => item.line_item_id).join(", ")}`);
    else if (amount > 0 && !refundLines.length)
      reasons.push(`refund_not_allocated: refund ${refund.id} of ${money(amount)} is not tied to the processing fee`);
  }
  if (refundedCents > feeCents)
    reasons.push(`refund_exceeds_fees: refunded ${money(refundedCents)} is more than the excluded fees ${money(feeCents)}`);

  return {
    eligible: reasons.length === 0,
    reasons,
    currency,
    merchandiseTotal: merchandiseCents / 100,
    shippingTotal: shippingCents / 100,
    expectedPayment: (merchandiseCents + shippingCents) / 100,
    refundedTotal: refundedCents / 100,
  };
}
