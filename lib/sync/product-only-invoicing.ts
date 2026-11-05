import type { ShopifyOrderLineItem } from "@/types/shopify";
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
