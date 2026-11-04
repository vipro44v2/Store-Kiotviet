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
  })
  .passthrough()
  .refine(
    (orders) => orders.invoiceCreationTrigger === "disabled" ||
      (!orders.invoiceCreationTrigger && orders.autoInvoice !== true) ||
      Boolean(orders.kiotVietCurrency),
    { message: "orders.kiotVietCurrency is required when invoice creation is enabled" },
  );

export type OrdersSettingsInput = z.infer<typeof ordersSettingsSchema>;
