import { z } from "zod";

/** Validation for the `orders` settings key. Safe to import from client components. */
export const ordersSettingsSchema = z
  .object({
    autoInvoice: z.boolean().optional(),
    invoiceCreationTrigger: z.enum(["shopify_fulfilled", "shopify_paid", "disabled"]).optional(),
    kiotVietCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
    invoicePrepaymentVerified: z.boolean().optional(),
    shippingSurcharge: z
      .object({
        id: z.number().int().positive(),
        code: z.string().trim().min(1),
        invoiceInheritsFromOrder: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Product-Only Invoicing (lib/sync/product-only-invoicing.ts). Absent = strict invoicing.
    productOnlyInvoicing: z.boolean().optional(),
    paymentSource: z.enum(["shopify"]).optional(),
    ignoreFinancialMismatch: z.boolean().optional(),
    excludeShipping: z.boolean().optional(),
    excludeProcessingFees: z.boolean().optional(),
    excludeOtherSurcharges: z.boolean().optional(),
    // Product-Only only: invoice an exactly prepaid order before KiotViet's prepayment
    // inheritance is proven; the result is verified right after creation.
    allowUnverifiedPrepaymentInheritance: z.boolean().optional(),
    acknowledgeUnverifiedPrepaymentRisk: z.boolean().optional(),
    // KiotViet prepayment larger than the product-only invoice (e.g. #1071): never automatic.
    prepaymentExceedsInvoicePolicy: z.enum(["block", "manual_override"]).optional(),
  })
  .passthrough()
  .refine(
    (orders) => orders.invoiceCreationTrigger === "disabled" ||
      (!orders.invoiceCreationTrigger && orders.autoInvoice !== true) ||
      Boolean(orders.kiotVietCurrency),
    { message: "orders.kiotVietCurrency is required when invoice creation is enabled" },
  )
  .refine(
    // Product-Only runs only through the invoice-trigger pipeline, never the legacy makeInvoice path.
    (orders) => orders.productOnlyInvoicing !== true || Boolean(orders.invoiceCreationTrigger),
    { message: "Product-Only Invoicing requires an explicit Invoice Creation Trigger" },
  )
  .refine(
    (orders) => orders.allowUnverifiedPrepaymentInheritance !== true ||
      (orders.productOnlyInvoicing === true && orders.acknowledgeUnverifiedPrepaymentRisk === true),
    { message: "Allow Unverified Prepayment Inheritance requires Product-Only Invoicing and an explicit confirmation of the accounting risk" },
  );

export type OrdersSettingsInput = z.infer<typeof ordersSettingsSchema>;
