/**
 * Which invoice validation reasons an administrator may explicitly approve in
 * the manual override. Deny by default: every other code (including codes added
 * later) stays a hard block. Automatic invoicing never uses this list.
 */
export const OVERRIDABLE_INVOICE_WARNINGS: Readonly<Record<string, string>> = {
  unsupported_shipping: "Shopify shipping is not recorded as a KiotViet surcharge",
  shipping_not_on_kiotviet_order: "The KiotViet order has no shipping surcharge",
  shipping_mismatch: "KiotViet shipping surcharge differs from Shopify shipping",
  total_mismatch: "KiotViet order total differs from the expected total",
  amount_mismatch: "Shopify total does not reconcile with the invoice lines",
  kiotviet_currency_not_configured: "orders.kiotVietCurrency is not configured",
  overpaid: "KiotViet already records more payment than the expected total",
  unsupported_discount: "Discount accounting differs between Shopify and KiotViet",
  unsupported_tax: "Tax added on top of prices is not represented in KiotViet",
  // Manual single-order exception only: the invoice is sent with no additional
  // payment and is always stored as needs_review (inheritance is checked after the POST).
  prepayment_inheritance_unverified: "It is unverified whether the invoice inherits the KiotViet order prepayment",
  // Product-Only payment cases outside the verified one; the invoice is sent with no payment
  // and the remaining difference keeps it needs_review (never automatic).
  prepayment_exceeds_invoice: "The KiotViet order prepayment is larger than the product-only invoice",
  prepayment_below_invoice: "The KiotViet order prepayment is smaller than the product-only invoice",
  kiotviet_payment_missing: "Shopify reports paid but the KiotViet order records no payment",
};

export function invoiceReasonCode(reason: string) {
  return reason.split(":")[0].trim();
}

export interface ClassifiedReasons {
  warnings: Array<{ code: string; message: string }>;
  blockers: Array<{ code: string; message: string }>;
}

export function classifyInvoiceReasons(reasons: string[]): ClassifiedReasons {
  const result: ClassifiedReasons = { warnings: [], blockers: [] };
  for (const reason of reasons) {
    const code = invoiceReasonCode(reason);
    (Object.hasOwn(OVERRIDABLE_INVOICE_WARNINGS, code) ? result.warnings : result.blockers).push({ code, message: reason });
  }
  return result;
}
