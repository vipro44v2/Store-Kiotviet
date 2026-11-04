import { z } from "zod";

/**
 * KiotViet does not document whether the payment recorded on an order
 * (POST /orders totalPayment) is carried to an invoice created from it
 * (POST /invoices with orderId). Invoicing a prepaid order is only allowed
 * after this was observed on a sandbox retailer
 * (scripts/verify-kiotviet-prepayment-inheritance.ts) AND accounting signed off
 * (orders.invoicePrepaymentVerified).
 */
export const PREPAYMENT_EVIDENCE_KEY = "kiotviet_prepayment_evidence";

export const prepaymentEvidenceSchema = z.object({
  retailer: z.string().min(1),
  testedAt: z.string().datetime(),
  order: z.object({ id: z.number(), code: z.string(), total: z.number(), prepaid: z.number() }),
  invoice: z.object({
    id: z.number(), code: z.string(), requestedTotalPayment: z.number(),
    total: z.number(), totalPayment: z.number(), paymentRows: z.array(z.object({ amount: z.number() })),
  }),
  orderAfter: z.object({ status: z.number().nullable(), totalPayment: z.number().nullable() }),
  result: z.enum(["carried", "not_carried", "inconclusive"]),
  notes: z.string().optional(),
});
export type PrepaymentEvidence = z.infer<typeof prepaymentEvidenceSchema>;

const cents = (value: number) => Math.round(value * 100);

/**
 * The sandbox test invoices a fully prepaid order with totalPayment 0.
 * - carried: the invoice reports the order's prepayment as paid (Khách đã trả =
 *   prepaid) and no extra payment row was created → paying "total − prepaid"
 *   records each payment exactly once;
 * - not_carried: the invoice reports 0 paid → prepaid orders must not be invoiced
 *   by this app (the remainder formula would leave the invoice unpaid while the
 *   order keeps the money);
 * - anything else is inconclusive.
 */
export function classifyPrepaymentObservation(observed: {
  prepaid: number; invoiceTotal: number; invoiceTotalPayment: number; paymentRows: Array<{ amount: number }>;
}): PrepaymentEvidence["result"] {
  if (cents(observed.prepaid) <= 0 || cents(observed.invoiceTotal) !== cents(observed.prepaid)) return "inconclusive";
  const rowsTotal = observed.paymentRows.reduce((sum, row) => sum + cents(row.amount), 0);
  if (cents(observed.invoiceTotalPayment) === cents(observed.prepaid) && rowsTotal <= cents(observed.prepaid)) return "carried";
  if (cents(observed.invoiceTotalPayment) === 0 && rowsTotal === 0) return "not_carried";
  return "inconclusive";
}

/** Prepaid orders may be invoiced only with sandbox evidence "carried" plus accounting sign-off. */
export function prepaymentInheritanceStatus(evidence: unknown, accountingVerified: boolean | undefined) {
  const parsed = prepaymentEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return { verified: false, reason: "no sandbox evidence recorded (scripts/verify-kiotviet-prepayment-inheritance.ts)" };
  if (parsed.data.result !== "carried")
    return { verified: false, reason: `sandbox evidence from ${parsed.data.retailer} says "${parsed.data.result}"` };
  if (accountingVerified !== true) return { verified: false, reason: "accounting has not signed off (orders.invoicePrepaymentVerified)" };
  return { verified: true, reason: `sandbox evidence ${parsed.data.invoice.code} on ${parsed.data.retailer} (${parsed.data.testedAt})` };
}
