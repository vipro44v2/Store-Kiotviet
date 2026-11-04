import type {
  ShopifyOrderLineItem,
  ShopifyOrderWebhook,
  ShopifyTaxLine,
} from "@/types/shopify";
import { ValidationError } from "@/lib/errors";
import { normalizeSku } from "./mappings";
import type { OrderSettings } from "./default-branch";

/**
 * Exact titles of payment-processing fee line items. Only lines without a SKU
 * match, so a real product that happens to share a title is never excluded.
 * Prefer configuring orders.processingFeeVariantIds / processingFeeProductIds.
 */
export const DEFAULT_PROCESSING_FEE_TITLES = [
  "SVC Fee - Credit Card Processing Fee",
];

export type ProcessingFeeReason =
  | "configured_variant_id"
  | "configured_product_id"
  | "exact_title_without_sku";

export interface ExcludedFeeLine {
  line: ShopifyOrderLineItem;
  reason: ProcessingFeeReason;
  /** Amount the customer was charged for this line, in minor units (cents). */
  chargedCents: number;
}

export interface OrderAmounts {
  shopifyTotal: number;
  excludedFeeTotal: number;
  /** Shopify total without processing fees; used as the KiotViet payment amount. */
  adjustedTotal: number;
  /** Non-fee lines + shipping + tips as charged by Shopify; should equal adjustedTotal. */
  expectedAdjustedTotal: number;
  consistent: boolean;
}

const idSet = (values: unknown) =>
  new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter((value) => /^\d+$/.test(value)),
  );

function feeRules(settings: OrderSettings) {
  const titles = Array.isArray(settings.processingFeeTitles)
    ? settings.processingFeeTitles
    : DEFAULT_PROCESSING_FEE_TITLES;
  return {
    variantIds: idSet(settings.processingFeeVariantIds),
    productIds: idSet(settings.processingFeeProductIds),
    titles: new Set(
      titles.filter((title): title is string => typeof title === "string").map((title) => title.trim()).filter(Boolean),
    ),
  };
}

export function processingFeeReason(
  line: ShopifyOrderLineItem,
  settings: OrderSettings = {},
): ProcessingFeeReason | null {
  const rules = feeRules(settings);
  if (line.variant_id != null && rules.variantIds.has(String(line.variant_id)))
    return "configured_variant_id";
  if (line.product_id != null && rules.productIds.has(String(line.product_id)))
    return "configured_product_id";
  if (
    !normalizeSku(line.sku) &&
    [line.title, line.name].some((title) => typeof title === "string" && rules.titles.has(title.trim()))
  )
    return "exact_title_without_sku";
  return null;
}

/** Shopify money string → integer minor units, so sums never accumulate float error. */
export function toCents(value: unknown, field: string): number {
  if (value === null || value === undefined || value === "") return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount))
    throw new ValidationError(`Shopify amount ${field} is not a number`);
  return Math.round(amount * 100);
}
const fromCents = (cents: number) => cents / 100;
const taxCents = (lines: ShopifyTaxLine[] | null | undefined, field: string) =>
  (lines ?? []).reduce((sum, tax) => sum + toCents(tax?.price, field), 0);

/** price × quantity − allocated discounts (+ line taxes when prices exclude tax). */
export function lineChargedCents(line: ShopifyOrderLineItem, taxesIncluded: boolean) {
  const field = `line item ${line.id}`;
  const gross = toCents(line.price, field) * Number(line.quantity ?? 0);
  const discounts = Array.isArray(line.discount_allocations)
    ? line.discount_allocations.reduce((sum, allocation) => sum + toCents(allocation?.amount, field), 0)
    : toCents(line.total_discount, field);
  return gross - discounts + (taxesIncluded ? 0 : taxCents(line.tax_lines, field));
}

/** Shipping the customer was charged (after shipping discounts), excluding shipping tax. */
export function shippingChargedCents(order: ShopifyOrderWebhook) {
  return (order.shipping_lines ?? []).reduce(
    (sum, shipping) => sum + toCents(shipping?.discounted_price ?? shipping?.price, "shipping_lines"),
    0,
  );
}

export function partitionOrderLines(
  order: ShopifyOrderWebhook,
  settings: OrderSettings = {},
) {
  const taxesIncluded = order.taxes_included === true;
  const purchased: Array<{ line: ShopifyOrderLineItem; index: number }> = [];
  const fees: ExcludedFeeLine[] = [];
  order.line_items.forEach((line, index) => {
    const reason = line ? processingFeeReason(line, settings) : null;
    if (reason)
      fees.push({ line, reason, chargedCents: lineChargedCents(line, taxesIncluded) });
    else purchased.push({ line, index });
  });
  return { purchased, fees };
}

export function computeOrderAmounts(
  order: ShopifyOrderWebhook,
  purchased: ShopifyOrderLineItem[],
  fees: ExcludedFeeLine[],
): OrderAmounts {
  const taxesIncluded = order.taxes_included === true;
  const shopifyTotalCents = toCents(order.total_price, "total_price");
  const excludedCents = fees.reduce((sum, fee) => sum + fee.chargedCents, 0);
  const adjustedCents = shopifyTotalCents - excludedCents;
  if (adjustedCents < 0)
    throw new ValidationError(
      `Shopify order ${order.id} processing fees exceed the order total`,
      { shopifyOrderId: String(order.id) },
    );
  const shippingCents = (order.shipping_lines ?? []).reduce(
    (sum, shipping) =>
      sum +
      toCents(shipping?.discounted_price ?? shipping?.price, "shipping_lines") +
      (taxesIncluded ? 0 : taxCents(shipping?.tax_lines, "shipping_lines")),
    0,
  );
  const expectedCents =
    purchased.reduce((sum, line) => sum + lineChargedCents(line, taxesIncluded), 0) +
    shippingCents +
    toCents(order.total_tip_received, "total_tip_received");
  return {
    shopifyTotal: fromCents(shopifyTotalCents),
    excludedFeeTotal: fromCents(excludedCents),
    adjustedTotal: fromCents(adjustedCents),
    expectedAdjustedTotal: fromCents(expectedCents),
    consistent: expectedCents === adjustedCents,
  };
}
