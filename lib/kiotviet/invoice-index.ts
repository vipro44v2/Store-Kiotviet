import { query } from "@/lib/db/client";
import { log } from "@/lib/logger";
import { kiotVietClient } from "./client";
import type { KiotVietInvoice, KiotVietInvoicesResponse } from "./types";

/**
 * Local copy of every KiotViet invoice's (id, code, orderCode, status), built
 * by one resumable pass over GET /invoices ordered by id ascending and then
 * extended incrementally (new invoices get higher ids and are appended).
 *
 * Proving "this order has no invoice" by scanning all invoices per order does
 * not scale (13k+ invoices), and the documented `orderId` filter is ambiguous.
 * The index fails closed instead of guessing:
 * - each page re-reads the last indexed invoice (overlap of 1); a different id
 *   means invoices were removed or reordered → full rebuild;
 * - ids must be strictly increasing, proving KiotViet honors orderBy=id;
 * - the remote total may never shrink;
 * - `current_as_of` is the start time of a request whose response showed every
 *   invoice indexed. Only a lookup started before that instant may treat a
 *   missing order code as "no invoice".
 */
export const INVOICE_INDEX_PAGE_SIZE = 100;

export interface InvoiceIndexState {
  scanned_count: number;
  last_invoice_id: string | null;
  remote_total: number | null;
  current_as_of: string | Date | null;
  generation: number;
  last_error: string | null;
}
export interface InvoiceIndexProgress {
  current: boolean;
  currentAsOf: Date | null;
  scanned: number;
  total: number | null;
  pages: number;
  error?: string;
}

export async function getInvoiceIndexState() {
  const [state] = await query<InvoiceIndexState>(
    "SELECT scanned_count,last_invoice_id::text,remote_total,current_as_of,generation,last_error FROM kiotviet_invoice_index_state WHERE id=1",
  );
  if (!state) throw new Error("kiotviet_invoice_index_state is missing; run migration 009");
  return state;
}

async function resetIndex(state: InvoiceIndexState, reason: string) {
  await query(
    `UPDATE kiotviet_invoice_index_state SET scanned_count=0,last_invoice_id=NULL,remote_total=NULL,current_as_of=NULL,
      generation=generation+1,last_error=$2,updated_at=now() WHERE id=1 AND generation=$1`,
    [state.generation, reason],
  );
  await log("warn", "KiotViet invoice index reset", { action: "invoice_index_reset", provider: "kiotviet", reason });
}

function asDate(value: string | Date | null) {
  return value === null ? null : new Date(value);
}

/** Advances the index by up to `maxPages` pages. Safe to run concurrently (optimistic state updates). */
export async function advanceInvoiceIndex(options: { maxPages?: number; deadlineMs?: number } = {}): Promise<InvoiceIndexProgress> {
  const maxPages = options.maxPages ?? 10;
  const deadline = Date.now() + (options.deadlineMs ?? 25_000);
  let state = await getInvoiceIndexState();
  let pages = 0;
  while (pages < maxPages && Date.now() < deadline) {
    const offset = state.scanned_count;
    const overlap = offset > 0 && state.last_invoice_id !== null ? 1 : 0;
    const startedAt = new Date();
    let page: KiotVietInvoicesResponse;
    try {
      page = await kiotVietClient.get<KiotVietInvoicesResponse>(`/invoices?${new URLSearchParams({
        orderBy: "id", orderDirection: "Asc", pageSize: String(INVOICE_INDEX_PAGE_SIZE), currentItem: String(offset - overlap),
      })}`, { timeoutMs: 15_000, maxAttempts: 2 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { current: false, currentAsOf: asDate(state.current_as_of), scanned: offset, total: state.remote_total, pages, error: message };
    }
    pages++;
    const total = Number(page?.total);
    const data = Array.isArray(page?.data) ? page.data : null;
    if (!data || !Number.isSafeInteger(total) || total < 0) {
      return { current: false, currentAsOf: asDate(state.current_as_of), scanned: offset, total: state.remote_total, pages, error: "malformed invoice page" };
    }
    if (state.remote_total !== null && total < state.remote_total) {
      await resetIndex(state, `remote invoice total decreased from ${state.remote_total} to ${total}`);
      state = await getInvoiceIndexState();
      continue;
    }
    const ids = data.map((invoice) => Number(invoice.id));
    if (overlap && ids[0] !== Number(state.last_invoice_id)) {
      await resetIndex(state, `overlap mismatch at offset ${offset}: expected invoice ${state.last_invoice_id}, got ${ids[0] ?? "none"}`);
      state = await getInvoiceIndexState();
      continue;
    }
    const fresh = data.slice(overlap);
    let previous = state.last_invoice_id === null ? 0 : Number(state.last_invoice_id);
    for (const invoice of fresh) {
      const id = Number(invoice.id);
      if (!Number.isSafeInteger(id) || id <= previous) {
        await resetIndex(state, "KiotViet did not return invoices in strictly increasing id order (orderBy=id not honored)");
        const after = await getInvoiceIndexState();
        return { current: false, currentAsOf: null, scanned: 0, total: null, pages, error: after.last_error ?? "ordering check failed" };
      }
      previous = id;
    }
    if (!fresh.length && offset < total)
      return { current: false, currentAsOf: asDate(state.current_as_of), scanned: offset, total, pages, error: "invoice page made no progress" };
    for (const invoice of fresh) await upsertIndexedInvoice(invoice);
    const scanned = offset + fresh.length;
    const current = scanned >= total;
    const updated = await query<InvoiceIndexState>(
      `UPDATE kiotviet_invoice_index_state SET scanned_count=$3,last_invoice_id=$4,remote_total=$5,
        current_as_of=CASE WHEN $6 THEN $7::timestamptz ELSE current_as_of END,last_error=NULL,updated_at=now()
      WHERE id=1 AND generation=$1 AND scanned_count=$2
      RETURNING scanned_count,last_invoice_id::text,remote_total,current_as_of,generation,last_error`,
      [state.generation, offset, scanned, fresh.length ? previous : state.last_invoice_id, total, current, startedAt.toISOString()],
    );
    // Another runner advanced first: continue from its state.
    state = updated[0] ?? (await getInvoiceIndexState());
    if (current && updated[0]) return { current: true, currentAsOf: startedAt, scanned, total, pages };
  }
  return { current: false, currentAsOf: asDate(state.current_as_of), scanned: state.scanned_count, total: state.remote_total, pages };
}

async function upsertIndexedInvoice(invoice: KiotVietInvoice) {
  await query(
    `INSERT INTO kiotviet_invoice_index(invoice_id,invoice_code,order_code,status) VALUES($1,$2,$3,$4)
    ON CONFLICT(invoice_id) DO UPDATE SET invoice_code=EXCLUDED.invoice_code,order_code=EXCLUDED.order_code,status=EXCLUDED.status,indexed_at=now()`,
    [invoice.id, invoice.code ?? "", invoice.orderCode || null, invoice.status ?? null],
  );
}

export async function indexedInvoicesForOrder(orderCode: string) {
  return query<{ invoice_id: string; invoice_code: string; order_code: string; status: number | null }>(
    "SELECT invoice_id::text,invoice_code,order_code,status FROM kiotviet_invoice_index WHERE order_code=$1",
    [orderCode],
  );
}
