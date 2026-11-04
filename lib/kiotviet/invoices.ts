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

const MAX_SCAN_PAGES = 20;

/**
 * Invoices whose orderCode is this KiotViet order. GET /invoices documents an
 * `orderId` filter but describes it as the invoice ID, so results are always
 * matched on orderCode, and absence is only confirmed (`complete: true`) by
 * scanning every invoice purchased since the order was placed.
 */
export async function findKiotVietInvoicesForOrder(
  order: { id: number; code: string },
  since: Date,
): Promise<{ invoices: KiotVietInvoice[]; complete: boolean }> {
  const matches = (data: KiotVietInvoice[] | undefined) =>
    (data ?? []).filter((invoice) => invoice.orderCode === order.code);
  const filtered = await kiotVietClient.get<KiotVietInvoicesResponse>(
    `/invoices?${new URLSearchParams({ orderId: String(order.id), pageSize: "100", currentItem: "0" })}`,
  );
  const found = new Map(matches(filtered.data).map((invoice) => [invoice.id, invoice]));
  let currentItem = 0, total = 1, pages = 0;
  while (currentItem < total && pages < MAX_SCAN_PAGES) {
    const page = await kiotVietClient.get<KiotVietInvoicesResponse>(`/invoices?${new URLSearchParams({
      fromPurchaseDate: since.toISOString(), pageSize: "100", currentItem: String(currentItem),
      orderBy: "purchaseDate", orderDirection: "Asc",
    })}`);
    for (const invoice of matches(page.data)) found.set(invoice.id, invoice);
    total = Number(page.total ?? 0);
    currentItem += Number(page.pageSize) || 100;
    pages++;
    if (!page.data?.length) break;
  }
  return { invoices: [...found.values()], complete: currentItem >= total };
}
