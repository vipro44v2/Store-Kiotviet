import type { ShopifyOrderWebhook } from "@/types/shopify";
import type { OrderSettings } from "./default-branch";
import { shippingChargedCents, toCents } from "./order-line-items";
import type { PreparedOrder } from "./order-sync";
import {
  discountedUnitPriceCents,
  lineDiscountCents,
  productOnlyPolicy,
  type FinancialDifference,
  type ProductOnlyPolicy,
} from "./product-only-invoicing";

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
  /** strict: exact-match rules below; product_only: see lib/sync/product-only-invoicing.ts. */
  mode?: "strict" | "product_only";
  /** Product-Only: what Shopify collected (total − successful refunds), the payment source of truth. */
  shopifyPaidTotal?: number;
  /** Product-Only: excluded charges and other expected differences; recorded, never blocking, never "reconciled". */
  differences?: FinancialDifference[];
  /** Product-Only: discounted unit price per Shopify line item ID, when representable in whole cents. */
  unitPrices?: Record<string, number>;
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
  const policy = productOnlyPolicy(settings);
  if (policy.enabled) return evaluateProductOnlyFinancials(order, prepared, settings, policy);
  const reasons: string[] = [];
  const taxesIncluded = order.taxes_included === true;
  const feeLineIds = new Set(prepared.fees.map((fee) => String(fee.line.id)));
  const feeCents = Math.round(prepared.amounts.excludedFeeTotal * 100);

  if (order.cancelled_at) reasons.push("order_cancelled: the Shopify order is cancelled");
  const financialStatus = order.financial_status ?? "unknown";
  if (financialStatus !== "paid" && financialStatus !== "partially_refunded")
    reasons.push(`not_paid: financial_status is ${financialStatus}`);

  const { reasons: currencyProblems, currency } = currencyReasons(order, settings);
  reasons.push(...currencyProblems);

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
    mode: "strict",
  };
}

function currencyReasons(order: ShopifyOrderWebhook, settings: OrderSettings) {
  const reasons: string[] = [];
  const configured = typeof settings.kiotVietCurrency === "string" ? settings.kiotVietCurrency.trim().toUpperCase() : "";
  const currency = order.currency ? order.currency.toUpperCase() : null;
  if (!configured) reasons.push("kiotviet_currency_not_configured: set orders.kiotVietCurrency to the currency KiotViet prices are recorded in");
  else if (!currency) reasons.push("order_currency_missing: the Shopify order has no currency");
  else if (currency !== configured)
    reasons.push(`currency_mismatch: Shopify order is in ${currency} but KiotViet is configured for ${configured}; currency conversion is not supported`);
  return { reasons, currency };
}

/**
 * Product-Only rules. The invoice value is Σ discounted unit price × quantity.
 * Excluded categories become `differences`; a category that is not excluded
 * blocks when present. Anything that changes the merchandise itself (product
 * refunds, unrepresentable discounts, added product tax, a Shopify total below
 * the merchandise) always blocks.
 */
export function evaluateProductOnlyFinancials(
  order: ShopifyOrderWebhook,
  prepared: PreparedOrder,
  settings: OrderSettings,
  policy: ProductOnlyPolicy,
): InvoiceFinancials {
  const reasons: string[] = [];
  const differences: FinancialDifference[] = [];
  const record = (code: string, amountCents: number, message: string) => {
    if (amountCents !== 0) differences.push({ code, amount: amountCents / 100, message });
  };
  const taxesIncluded = order.taxes_included === true;
  const feeLineIds = new Set(prepared.fees.map((fee) => String(fee.line.id)));

  if (order.cancelled_at) reasons.push("order_cancelled: the Shopify order is cancelled");
  const financialStatus = order.financial_status ?? "unknown";
  // paymentSource "shopify": Shopify's status alone says whether the customer paid.
  if (financialStatus !== "paid" && financialStatus !== "partially_refunded")
    reasons.push(`not_paid: Shopify financial_status is ${financialStatus}`);
  const { reasons: currencyProblems, currency } = currencyReasons(order, settings);
  reasons.push(...currencyProblems);

  let merchandiseCents = 0, productTaxCents = 0;
  const unitPrices: Record<string, number> = {};
  for (const { line, quantity } of prepared.lines) {
    const unit = discountedUnitPriceCents(line, quantity);
    if (unit === null) {
      reasons.push(`discount_not_representable: line item ${line.id} discount cannot be split over ${quantity} unit(s) in whole cents`);
      merchandiseCents += toCents(line.price, `line item ${line.id}`) * quantity - lineDiscountCents(line);
    } else {
      unitPrices[String(line.id)] = unit / 100;
      merchandiseCents += unit * quantity;
    }
    productTaxCents += (line.tax_lines ?? []).reduce((sum, taxLine) => sum + toCents(taxLine?.price, "tax"), 0);
  }
  // Tax charged on top of product prices is not a surcharge; it is never silently dropped.
  if (!taxesIncluded && productTaxCents > 0)
    reasons.push(`unsupported_tax: ${money(productTaxCents)} product tax is added on top of prices`);

  const shippingCents = shippingChargedCents(order);
  const shippingTaxCents = taxesIncluded ? 0 : (order.shipping_lines ?? []).reduce(
    (sum, shipping) => sum + (shipping?.tax_lines ?? []).reduce((total, taxLine) => total + toCents(taxLine?.price, "tax"), 0), 0);
  if (shippingCents + shippingTaxCents > 0) {
    if (policy.excludeShipping) record("shipping_excluded", shippingCents + shippingTaxCents, `Shopify shipping ${money(shippingCents + shippingTaxCents)} is not on the product-only invoice`);
    else reasons.push(`shipping_not_excluded: Shopify charged ${money(shippingCents + shippingTaxCents)} shipping; enable orders.excludeShipping to invoice products only`);
  }
  const feeCents = Math.round(prepared.amounts.excludedFeeTotal * 100);
  if (feeCents > 0) {
    if (policy.excludeProcessingFees) record("processing_fee_excluded", feeCents, `Processing fees ${money(feeCents)} are not on the invoice`);
    else reasons.push(`processing_fee_not_excluded: ${money(feeCents)} processing fees; enable orders.excludeProcessingFees`);
  }
  const tipCents = toCents(order.total_tip_received, "tip");
  if (tipCents > 0) {
    if (policy.excludeOtherSurcharges) record("tip_excluded", tipCents, `Tip ${money(tipCents)} is not on the invoice`);
    else reasons.push(`unsupported_tip: tip of ${money(tipCents)}; enable orders.excludeOtherSurcharges`);
  }
  const shopifyTotalCents = toCents(order.total_price, "total_price");
  const productChargesCents = merchandiseCents + (taxesIncluded ? 0 : productTaxCents);
  const explainedCents = productChargesCents + shippingCents + shippingTaxCents + feeCents + tipCents;
  const otherCents = shopifyTotalCents - explainedCents;
  if (otherCents < 0)
    // The customer paid less than the merchandise and charges: invoicing it would overstate the sale.
    reasons.push(`amount_mismatch: Shopify total ${money(shopifyTotalCents)} is ${money(-otherCents)} below merchandise and charges ${money(explainedCents)}`);
  else if (otherCents > 0) {
    if (policy.excludeOtherSurcharges && policy.ignoreFinancialMismatch)
      record("other_charges_excluded", otherCents, `Shopify total includes ${money(otherCents)} of other non-product charges`);
    else reasons.push(`amount_mismatch: Shopify total ${money(shopifyTotalCents)} has ${money(otherCents)} not explained by products, shipping, fees and tips`);
  }

  // Refunds: product refunds change the merchandise; refunds of excluded charges do not.
  let refundedCents = 0;
  const refunds = order.refunds ?? [];
  if (financialStatus === "partially_refunded" && !refunds.length)
    reasons.push("refund_details_missing: partially_refunded order without refund details");
  for (const refund of refunds) {
    const amount = (refund.transactions ?? [])
      .filter((transaction) => transaction?.kind === "refund" && transaction?.status === "success")
      .reduce((sum, transaction) => sum + toCents(transaction?.amount, "refund"), 0);
    refundedCents += amount;
    const productLines = (refund.refund_line_items ?? []).filter((item) => Number(item.quantity) > 0 && !feeLineIds.has(String(item.line_item_id)));
    if (productLines.length)
      reasons.push(`refund_affects_products: refund ${refund.id} refunds line item(s) ${productLines.map((item) => item.line_item_id).join(", ")}`);
  }
  const excludedChargesCents = Math.max(0, shopifyTotalCents - productChargesCents);
  if (refundedCents > excludedChargesCents)
    reasons.push(`refund_exceeds_excluded_charges: refunded ${money(refundedCents)} is more than the excluded charges ${money(excludedChargesCents)}`);
  else record("refund_of_excluded_charges", -refundedCents, `Shopify refunded ${money(refundedCents)} of excluded charges`);
  const shopifyPaidCents = shopifyTotalCents - refundedCents;
  record("shopify_paid_vs_invoice", shopifyPaidCents - merchandiseCents,
    `Shopify collected ${money(shopifyPaidCents)}; the product-only invoice is ${money(merchandiseCents)}`);

  return {
    eligible: reasons.length === 0,
    reasons,
    currency,
    merchandiseTotal: merchandiseCents / 100,
    shippingTotal: 0,
    expectedPayment: merchandiseCents / 100,
    refundedTotal: refundedCents / 100,
    mode: "product_only",
    shopifyPaidTotal: shopifyPaidCents / 100,
    differences,
    unitPrices,
  };
}
