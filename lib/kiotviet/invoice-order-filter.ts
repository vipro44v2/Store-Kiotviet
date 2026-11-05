/**
 * Does GET /invoices?orderId=X return exactly the invoices created from KiotViet
 * order X? Public API 2.12 lists the parameter but not its semantics, so this is
 * measured (scripts/verify-kiotviet-invoice-order-filter.ts), never assumed.
 *
 * Even "filters" is not proof of absence: the lookup only uses the filter as an
 * extra source of invoices to link when completeness could not be established.
 * "ignored" makes the lookup skip the request entirely.
 */
export interface OrderFilterSample {
  orderId: number;
  orderCode: string;
  /** Invoice ids known (index / invoice_mappings) to belong to this order; [] for an order without invoices. */
  knownInvoiceIds: number[];
  response: { total: number; data: Array<{ id: number; orderCode?: string | null }> };
}

export type OrderFilterResult = "filters" | "ignored" | "inconclusive";

export function classifyOrderFilter(samples: OrderFilterSample[], control: OrderFilterSample["response"]) {
  const notes: string[] = [];
  let ignored = false, missing = false;
  if (control.total > 0 || control.data.length > 0) {
    ignored = true;
    notes.push(`a nonexistent orderId returned ${control.total} invoice(s)`);
  }
  for (const sample of samples) {
    const foreign = sample.response.data.filter((invoice) => invoice.orderCode !== sample.orderCode);
    if (foreign.length) {
      ignored = true;
      notes.push(`orderId ${sample.orderId} (${sample.orderCode}) returned ${foreign.length} invoice(s) of other orders`);
    }
    const returned = new Set(sample.response.data.map((invoice) => Number(invoice.id)));
    const absent = sample.knownInvoiceIds.filter((id) => !returned.has(id));
    if (absent.length) {
      missing = true;
      notes.push(`orderId ${sample.orderId} (${sample.orderCode}) did not return known invoice(s) ${absent.join(", ")}`);
    }
  }
  const withInvoices = samples.filter((sample) => sample.knownInvoiceIds.length > 0).length;
  const result: OrderFilterResult = ignored ? "ignored"
    : !missing && withInvoices >= 3 && samples.length > withInvoices ? "filters"
    : "inconclusive";
  if (result === "inconclusive" && !missing) notes.push("need at least 3 orders with invoices and 1 without");
  return { result, notes };
}
