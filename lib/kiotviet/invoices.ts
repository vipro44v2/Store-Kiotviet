import { UncertainResultError } from "@/lib/errors";
import { kiotVietClient } from "./client";
import type { KiotVietInvoice, KiotVietInvoicesResponse } from "./types";

/** POST /invoices (Public API 2.12). `orderId` invoices an existing KiotViet order. */
export interface KiotVietInvoiceInput {
  branchId: number;
  orderId: number;
  customerId?: number;
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
 * Retail docs' orderId description is ambiguous. A filtered result is a hint,
 * never proof of absence. Branch/customer filters speed up finding manual
 * invoices, but cannot prove absence if staff changed invoice ownership.
 * Only a complete bounded retailer-wide scan proves absence. No purchase-date
 * bound is used (staff may backdate invoices). Large catalogs fail closed.
 * https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/ ?2.12.1
 */
export async function findKiotVietInvoicesForOrder(
  order: { id: number; code: string; branchId?: number; customerId?: number | null },
  _since: Date,
): Promise<{ invoices: KiotVietInvoice[]; complete: boolean }> {
  const found = new Map<number, KiotVietInvoice>();
  const started = Date.now();
  const request = async (params: Record<string, string>, phase: string) => {
    const at = Date.now();
    let response: KiotVietInvoicesResponse | undefined;
    try {
      response = await kiotVietClient.get<KiotVietInvoicesResponse>(        `/invoices?${new URLSearchParams({ pageSize: "100", ...params })}`,
        { timeoutMs: 8_000, maxAttempts: 1 });
      return response;
    } finally {
      process.stderr.write(JSON.stringify({ action: "invoice_lookup_page", orderId: order.id, phase,
        offset: params.currentItem, total: response?.total, returned: response?.data?.length, requestMs: Date.now()-at, elapsedMs: Date.now()-started })+"\n");
    }
  };
  const collect = (data: KiotVietInvoice[]) => {
    for (const invoice of data) if (invoice.orderCode === order.code) found.set(invoice.id, invoice);
  };
  try {
    const hint = await request({ orderId: String(order.id), currentItem: "0" }, "order_filter");
    collect(hint.data ?? []);
    if (order.branchId || order.customerId) {
      const scoped = await request({ currentItem: "0",
        ...(order.branchId ? { branchIds: String(order.branchId) } : {}),
        ...(order.customerId ? { customerIds: String(order.customerId) } : {}),
      }, "scoped_hint");
      collect(scoped.data ?? []);
    }
    let offset = 0;
    let expectedTotal: number | undefined;
    const seen = new Set<number>();
    for (let page = 0; page < 10 && Date.now()-started < 25_000; page++) {
      const result = await request({ currentItem: String(offset), orderBy: "id", orderDirection: "Asc" }, "complete_scan");
      const data = result.data;
      const total = Number(result.total);
      if (!Array.isArray(data) || result.total == null || !Number.isSafeInteger(total) || total < 0) break;
      collect(data);
      if (data.some(invoice => !("orderCode" in invoice))) break;
      // Do not spend minutes scanning thousands of unrelated invoices.
      if (total > 1000) break;
      if (expectedTotal !== undefined && total !== expectedTotal) break;
      expectedTotal = total;
      if (data.some(i => !Number.isSafeInteger(Number(i.id)) || seen.has(i.id))) break;
      for (const invoice of data) seen.add(invoice.id);
      if (seen.size !== offset + data.length) break;
      offset += data.length;
      if (offset === total) return { invoices: [...found.values()], complete: true };
      if (!data.length || offset > total) break;
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ action: "invoice_lookup_incomplete", orderId: order.id,
      elapsedMs: Date.now()-started, error: error instanceof Error ? error.message : String(error) })+"\n");
  }
  return { invoices: [...found.values()], complete: false };
}
