import { ApiError, UncertainResultError } from "@/lib/errors";
import { kiotVietClient } from "./client";
import type { KiotVietInvoice, KiotVietInvoicesResponse } from "./types";
import { query } from "@/lib/db/client";
import {
  countedGet,
  ensureIndexFresh,
  forgetIndexedInvoice,
  indexedInvoicesForOrder,
  INVOICE_INDEX_LOOKUP_CATCH_UP,
  localLookupSnapshot,
  scanInvoicesAboveFloor,
  withApiCallCount,
  type IndexFreshness,
} from "./invoice-index";

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

export interface InvoiceLookupMetrics {
  method: "index" | "floor_scan" | null;
  /** How index completeness was established (null when it was not, or by the floor scan). */
  freshness: IndexFreshness | null;
  /** PostgreSQL-only part (invoice_mappings + kiotviet_invoice_index candidates). */
  localMs: number;
  /** Freshness proof, the orderId hint and candidate re-reads. */
  remoteMs: number;
  /** Completeness step only (index freshness or floor scan), including waiting for a shared refresh. */
  refreshMs: number;
  /** Re-reading candidate invoices from KiotViet. */
  rereadMs: number;
  totalMs: number;
  apiCalls: number;
  candidates: number;
  indexLag: number | null;
}

export interface InvoiceLookup {
  invoices: KiotVietInvoice[];
  complete: boolean;
  indexError?: string;
  method?: "floor_scan" | "index";
  metrics?: InvoiceLookupMetrics;
}

/** Evidence written by scripts/verify-kiotviet-invoice-order-filter.ts. */
export const ORDER_FILTER_EVIDENCE_KEY = "kiotviet_invoice_order_filter_evidence";

/**
 * Invoices whose orderCode is this KiotViet order. `complete: true` (proof of
 * absence) only when completeness was established for invoices that existed
 * when this lookup began (database clock):
 * 1. local candidates from PostgreSQL (no remote request);
 * 2. completeness: the shared index freshness check (0–1 requests; reused across
 *    jobs, never re-proven twice in one process), or, while the index lags, the
 *    floor scan for orders this app created;
 * 3. only the candidates found are re-read so their status is current.
 * GET /invoices?orderId= is undocumented in its semantics (Public API 2.12) and
 * is never proof of anything: it is asked only when completeness failed, as an
 * extra source of invoices to link, and its results must match on orderCode.
 * https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/ (2.12)
 */
export async function findKiotVietInvoicesForOrder(
  order: { id: number; code: string; branchId?: number; customerId?: number | null; invoiceIdFloor?: number },
  _since?: Date,
  options: { maxIndexPages?: number } = {},
): Promise<InvoiceLookup> {
  const started = performance.now();
  const { result, calls } = await withApiCallCount(async () => {
    // One round trip: lookup start (DB clock), index checkpoint and local candidates.
    const snapshot = await localLookupSnapshot(order);
    const { lookupStart, state } = snapshot;
    const candidates = new Set(snapshot.candidates);
    const localMs = performance.now() - started;
    const indexLag = state.remote_total === null ? null : Math.max(0, state.remote_total - state.scanned_count);
    let refreshMs = 0;
    const indexFirst = indexLag !== null && indexLag <= INVOICE_INDEX_LOOKUP_CATCH_UP;
    let complete = false, method: InvoiceLookup["method"], freshness: IndexFreshness | null = null;
    const errors: string[] = [];
    for (const path of indexFirst ? ["index", "floor"] : ["floor", "index"]) {
      if (complete) break;
      const refreshStarted = performance.now();
      if (path === "floor") {
        if (!order.invoiceIdFloor) continue;
        const tail = await scanInvoicesAboveFloor(order.invoiceIdFloor);
        for (const invoice of tail.invoices) if (invoice.orderCode === order.code) candidates.add(Number(invoice.id));
        if (tail.complete) [complete, method] = [true, "floor_scan"];
        else errors.push(tail.error);
      } else {
        const fresh = await ensureIndexFresh(lookupStart, { maxPages: options.maxIndexPages ?? 10 }, state);
        if (fresh.complete) {
          [complete, method, freshness] = [true, "index", fresh.freshness];
          // Only when the check appended invoices can the index hold new candidates.
          if (fresh.progress.scanned > state.scanned_count)
            for (const row of await indexedInvoicesForOrder(order.code)) candidates.add(Number(row.invoice_id));
        } else if (fresh.error) errors.push(fresh.error);
      }
      refreshMs += performance.now() - refreshStarted;
    }
    if (!complete) for (const id of await orderFilterHint(order)) candidates.add(id);
    const rereadStarted = performance.now();
    const invoices = candidates.size ? await currentInvoices(candidates, order.code) : [];
    const rereadMs = performance.now() - rereadStarted;
    return { invoices, complete, method, freshness, errors, localMs, refreshMs, rereadMs, candidates: candidates.size, indexLag };
  });
  const totalMs = performance.now() - started;
  const metrics: InvoiceLookupMetrics = {
    method: result.method ?? null, freshness: result.freshness, localMs: round(result.localMs), remoteMs: round(totalMs - result.localMs),
    refreshMs: round(result.refreshMs), rereadMs: round(result.rereadMs),
    totalMs: round(totalMs), apiCalls: calls, candidates: result.candidates, indexLag: result.indexLag,
  };
  return {
    invoices: result.invoices, complete: result.complete, metrics,
    ...(result.complete ? { method: result.method } : { indexError: result.errors.join("; ") || "invoice index not current" }),
  };
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/**
 * GET /invoices?orderId= as a candidate source only. Skipped when the read-only
 * verification found that KiotViet ignores the filter (it would just cost a request).
 */
async function orderFilterHint(order: { id: number; code: string }) {
  const [evidence] = await query<{ value: { result?: string } }>("SELECT value FROM system_settings WHERE key=$1", [ORDER_FILTER_EVIDENCE_KEY]);
  if (evidence?.value?.result === "ignored") return [];
  try {
    const hint = await countedGet<KiotVietInvoicesResponse>(
      `/invoices?${new URLSearchParams({ orderId: String(order.id), pageSize: "100", currentItem: "0" })}`,
      { timeoutMs: 8_000, maxAttempts: 1 },
    );
    return (hint.data ?? []).filter((invoice) => invoice.orderCode === order.code).map((invoice) => Number(invoice.id));
  } catch {
    return []; // a failed hint never proves anything
  }
}

/** Candidates are re-read so their status is current; only invoices of this order code count. */
async function currentInvoices(candidates: Set<number>, orderCode: string) {
  const invoices: KiotVietInvoice[] = [];
  for (const id of candidates) {
    let detail: KiotVietInvoiceDetail;
    try {
      detail = await countedGet<KiotVietInvoiceDetail>(`/invoices/${id}`);
    } catch (error) {
      // An invoice deleted in KiotViet: it no longer exists, so it is not a duplicate.
      if (error instanceof ApiError && error.status === 404) { await forgetIndexedInvoice(id); continue; }
      throw error;
    }
    if (detail?.orderCode === orderCode) invoices.push({ id: detail.id, code: detail.code, orderCode: detail.orderCode, status: detail.status, statusValue: detail.statusValue });
  }
  return invoices;
}
