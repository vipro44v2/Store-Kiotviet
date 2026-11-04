import { UncertainResultError } from "@/lib/errors";
import { kiotVietClient } from "./client";
import type { KiotVietInvoice, KiotVietInvoicesResponse } from "./types";
import { advanceInvoiceIndex, indexedInvoicesForOrder } from "./invoice-index";

/** POST /invoices (Public API 2.12). `orderId` invoices an existing KiotViet order. */
export interface KiotVietInvoiceInput {
  branchId: number;
  orderId: number;
  customerId?: number;
  /** Seller (KiotViet user ID). KiotViet rejects invoices whose seller was deleted (HTTP 420). */
  soldById?: number;
  purchaseDate?: string;
  discount: number;
  totalPayment: number;
  method: string;
  invoiceDetails: Array<{
    productId: number;
    productCode: string;
    productName: string;
    quantity: number;
    price: number;
    discount: number;
  }>;
}

/** Invoice status per the invoice.update webhook docs: 1 completed, 2 cancelled, 3 processing, 5 undeliverable. */
export const KIOTVIET_INVOICE_CANCELLED = 2;

export interface KiotVietInvoiceDetail extends KiotVietInvoice {
  branchId?: number;
  total?: number;
  totalPayment?: number;
  invoiceDetails?: Array<{ productId: number; quantity: number; price: number; discount?: number }>;
  invoiceOrderSurcharges?: Array<{ surchargeId?: number | null; price?: number | null }> | null;
  /** GET /invoices/{id} payments (documented: id, code, amount, method, status, transDate, …). */
  payments?: Array<{ amount?: number | null; method?: string | null }> | null;
}

/** Not idempotent: never resent automatically; callers look the invoice up first. */
export async function createKiotVietInvoice(input: KiotVietInvoiceInput) {
  const created = await kiotVietClient.post<{ id: number; code: string; total?: number; totalPayment?: number }>(
    "/invoices", input, { nonIdempotent: true },
  );
  if (!created || !Number.isSafeInteger(Number(created.id)) || Number(created.id) <= 0)
    throw new UncertainResultError("KiotViet invoice creation returned no invoice ID; the invoice may have been created");
  return created;
}

export function getKiotVietInvoiceDetail(id: number) {
  return kiotVietClient.get<KiotVietInvoiceDetail>(`/invoices/${id}`);
}

/**
 * Invoices whose orderCode is this KiotViet order. `complete: true` (proof of
 * absence) only when the local invoice index (./invoice-index.ts) was confirmed
 * current by a request started after this lookup began. The documented
 * `orderId` filter is ambiguous, so its results are only a hint and are always
 * matched on orderCode. Candidates are re-read so their status is current.
 * https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/ (2.12)
 */
export async function findKiotVietInvoicesForOrder(
  order: { id: number; code: string; branchId?: number; customerId?: number | null },
  _since?: Date,
  options: { maxIndexPages?: number } = {},
): Promise<{ invoices: KiotVietInvoice[]; complete: boolean; indexError?: string }> {
  const lookupStart = new Date();
  const candidates = new Set<number>();
  try {
    const hint = await kiotVietClient.get<KiotVietInvoicesResponse>(
      `/invoices?${new URLSearchParams({ orderId: String(order.id), pageSize: "100", currentItem: "0" })}`,
      { timeoutMs: 8_000, maxAttempts: 1 },
    );
    for (const invoice of hint.data ?? []) if (invoice.orderCode === order.code) candidates.add(Number(invoice.id));
  } catch {
    // A failed hint never proves anything; the index below decides completeness.
  }
  const index = await advanceInvoiceIndex({ maxPages: options.maxIndexPages ?? 10, deadlineMs: 25_000 });
  for (const row of await indexedInvoicesForOrder(order.code)) candidates.add(Number(row.invoice_id));
  const invoices: KiotVietInvoice[] = [];
  for (const id of candidates) {
    const detail = await getKiotVietInvoiceDetail(id);
    if (detail?.orderCode === order.code) invoices.push({ id: detail.id, code: detail.code, orderCode: detail.orderCode, status: detail.status, statusValue: detail.statusValue });
  }
  const complete = index.current && index.currentAsOf !== null && index.currentAsOf.getTime() >= lookupStart.getTime();
  return { invoices, complete, ...(complete ? {} : { indexError: index.error ?? `invoice index not current (${index.scanned}/${index.total ?? "?"} indexed)` }) };
}
