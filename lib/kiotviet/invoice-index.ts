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
 *   means invoices before it were removed (offsets shifted). The scan position
 *   is then re-located by binary search on id (repositionIndex), which keeps the
 *   already indexed invoices; only an unsortable remote list forces a rebuild;
 * - ids must be strictly increasing, proving KiotViet honors orderBy=id;
 * - a shrinking remote total (deleted invoices) is caught by the overlap check;
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
      generation=generation+1,last_error=$2,updated_at=now(),reset_count=reset_count+1,last_reset_at=now() WHERE id=1 AND generation=$1`,
    [state.generation, reason],
  );
  await log("warn", "KiotViet invoice index reset", { action: "invoice_index_reset", provider: "kiotviet", reason });
}

/** Upper bound of GET requests for one reposition (2^20 ≈ 1M invoices). */
export const REPOSITION_MAX_REQUESTS = 22;

async function remoteIdAt(position: number) {
  const page = await kiotVietClient.get<KiotVietInvoicesResponse>(`/invoices?${new URLSearchParams({
    orderBy: "id", orderDirection: "Asc", pageSize: "1", currentItem: String(position),
  })}`, { timeoutMs: 15_000, maxAttempts: 2 });
  const id = Number(page?.data?.[0]?.id);
  return { id: Number.isSafeInteger(id) && id > 0 ? id : null, total: Number(page?.total) };
}

/**
 * Invoices before the scan position were deleted, so remote offsets shifted.
 * Every invoice that still exists with id ≤ last_invoice_id is already indexed
 * (KiotViet allocates increasing ids), so the scan resumes at the first remote
 * position whose id is greater: binary search, ~log2(total) single-row reads.
 * Returns an error string (state unchanged) when it cannot prove the position.
 */
async function repositionIndex(state: InvoiceIndexState, total: number, reason: string): Promise<string | null> {
  const lastId = Number(state.last_invoice_id);
  let low = 0, high = total, requests = 0;
  let below: number | null = null; // id at position low-1
  try {
    while (low < high) {
      if (++requests > REPOSITION_MAX_REQUESTS) return "invoice index reposition exceeded its request budget";
      const middle = Math.floor((low + high) / 2);
      const { id } = await remoteIdAt(middle);
      if (id === null) return `invoice index reposition read no invoice at position ${middle}`;
      if (id <= lastId) { low = middle + 1; below = id; } else high = middle;
    }
  } catch (error) {
    return `invoice index reposition failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The next page re-reads `below` as its overlap and re-checks strict id order,
  // so a remote list that is not really sorted still ends in a full rebuild.
  const moved = await query(
    `UPDATE kiotviet_invoice_index_state SET scanned_count=$3,last_invoice_id=$4,remote_total=$5,last_error=$6,
      reposition_count=reposition_count+1,last_reposition_at=now(),updated_at=now()
    WHERE id=1 AND generation=$1 AND scanned_count=$2 RETURNING id`,
    [state.generation, state.scanned_count, low, low > 0 ? below : null, total, `repositioned: ${reason}`],
  );
  await log("warn", "KiotViet invoice index repositioned", {
    action: "invoice_index_repositioned", provider: "kiotviet", reason, from: state.scanned_count, to: low, requests, applied: moved.length > 0,
  });
  return null;
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
    const ids = data.map((invoice) => Number(invoice.id));
    if (overlap && ids[0] !== Number(state.last_invoice_id)) {
      const reason = `overlap mismatch at offset ${offset}: expected invoice ${state.last_invoice_id}, got ${ids[0] ?? "none"} (remote total ${state.remote_total ?? "?"} → ${total})`;
      const failed = await repositionIndex(state, total, reason);
      if (failed) {
        await query("UPDATE kiotviet_invoice_index_state SET last_error=$2,updated_at=now() WHERE id=1 AND generation=$1", [state.generation, `${reason}; ${failed}`]);
        return { current: false, currentAsOf: asDate(state.current_as_of), scanned: offset, total: state.remote_total, pages, error: failed };
      }
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

/** Remaining invoices the next lookup may index itself (findKiotVietInvoicesForOrder advances ≤ 10 pages). */
export const INVOICE_INDEX_LOOKUP_CATCH_UP = 5 * INVOICE_INDEX_PAGE_SIZE;
/** No confirmed-current index for this long means the scheduler is not keeping up (or not running). */
export const INVOICE_INDEX_STALE_MS = 15 * 60_000;

export interface InvoiceIndexHealth {
  scanned: number;
  total: number | null;
  /** Invoices not yet indexed; null while a rebuild has not read the first page. */
  lag: number | null;
  currentAsOf: Date | null;
  /** A lookup can prove absence by catching up itself, without a long rebuild. */
  usable: boolean;
  stale: boolean;
  lastError: string | null;
  generation: number;
}

export async function getInvoiceIndexHealth(now = Date.now()): Promise<InvoiceIndexHealth> {
  const state = await getInvoiceIndexState();
  const lag = state.remote_total === null ? null : Math.max(0, state.remote_total - state.scanned_count);
  const currentAsOf = asDate(state.current_as_of);
  return {
    scanned: state.scanned_count, total: state.remote_total, lag, currentAsOf,
    usable: lag !== null && lag <= INVOICE_INDEX_LOOKUP_CATCH_UP,
    stale: !currentAsOf || now - currentAsOf.getTime() > INVOICE_INDEX_STALE_MS,
    lastError: state.last_error, generation: state.generation,
  };
}

export async function forgetIndexedInvoice(invoiceId: number) {
  await query("DELETE FROM kiotviet_invoice_index WHERE invoice_id=$1", [invoiceId]);
  await log("warn", "Deleted KiotViet invoice removed from the index", { action: "invoice_index_forget", provider: "kiotviet", invoiceId });
}

export async function indexedInvoicesForOrder(orderCode: string) {
  return query<{ invoice_id: string; invoice_code: string; order_code: string; status: number | null }>(
    "SELECT invoice_id::text,invoice_code,order_code,status FROM kiotviet_invoice_index WHERE order_code=$1",
    [orderCode],
  );
}
