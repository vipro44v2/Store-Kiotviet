import { AsyncLocalStorage } from "node:async_hooks";
import { query } from "@/lib/db/client";
import { log } from "@/lib/logger";
import { kiotVietClient } from "./client";
import type { KiotVietInvoice, KiotVietInvoicesResponse } from "./types";

/** Counts KiotViet requests made on behalf of one duplicate lookup (metrics only). */
const apiCallScope = new AsyncLocalStorage<{ calls: number }>();
export function withApiCallCount<T>(work: () => Promise<T>) {
  const counter = { calls: 0 };
  return apiCallScope.run(counter, async () => ({ result: await work(), calls: counter.calls }));
}
export function countedGet<T>(url: string, options?: Parameters<typeof kiotVietClient.get>[1]) {
  const counter = apiCallScope.getStore();
  if (counter) counter.calls++;
  return kiotVietClient.get<T>(url, options);
}

/**
 * Database clock. Freshness timestamps from different workers are compared, so they
 * all come from PostgreSQL rather than each process's own clock.
 */
export async function dbNow() {
  const [row] = await query<{ now: string | Date }>("SELECT clock_timestamp() AS now");
  return new Date(row.now);
}

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
  const page = await countedGet<KiotVietInvoicesResponse>(`/invoices?${new URLSearchParams({
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
    const startedAt = await dbNow();
    let page: KiotVietInvoicesResponse;
    try {
      page = await countedGet<KiotVietInvoicesResponse>(`/invoices?${new URLSearchParams({
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
    const scanned = offset + fresh.length;
    const current = scanned >= total;
    const updated = await savePage(state, offset, { scanned, lastInvoiceId: fresh.length ? previous : state.last_invoice_id, total, current, startedAt }, fresh);
    // Another runner advanced first: continue from its state.
    state = updated[0] ?? (await getInvoiceIndexState());
    if (current && updated[0]) return { current: true, currentAsOf: startedAt, scanned, total, pages };
  }
  return { current: false, currentAsOf: asDate(state.current_as_of), scanned: state.scanned_count, total: state.remote_total, pages };
}

/**
 * One statement per page: advances the checkpoint and upserts the page's invoices
 * atomically (a single statement is its own transaction). The rows are written only
 * if the guarded checkpoint update matched (generation + scanned_count), and the
 * checkpoint only moves together with its rows, so a crash or error leaves both
 * unchanged and the page is simply read again. A concurrent runner on the same page
 * waits on the state row lock, then matches no row and writes nothing.
 * Replaces ~100 single-row UPSERTs + 1 UPDATE per page (measured ~20× faster).
 */
async function savePage(
  state: InvoiceIndexState, offset: number,
  next: { scanned: number; lastInvoiceId: number | string | null; total: number; current: boolean; startedAt: Date },
  invoices: KiotVietInvoice[],
) {
  return query<InvoiceIndexState>(
    `WITH advanced AS (
      UPDATE kiotviet_invoice_index_state SET scanned_count=$3,last_invoice_id=$4,remote_total=$5,
        current_as_of=CASE WHEN $6 THEN $7::timestamptz ELSE current_as_of END,last_error=NULL,updated_at=now()
      WHERE id=1 AND generation=$1 AND scanned_count=$2
      RETURNING scanned_count,last_invoice_id::text,remote_total,current_as_of,generation,last_error),
    saved AS (
      INSERT INTO kiotviet_invoice_index(invoice_id,invoice_code,order_code,status)
      SELECT DISTINCT ON (page.id) page.id,page.code,page.order_code,page.status
      FROM unnest($8::bigint[],$9::text[],$10::text[],$11::int[]) AS page(id,code,order_code,status)
      WHERE EXISTS (SELECT 1 FROM advanced) ORDER BY page.id
      ON CONFLICT(invoice_id) DO UPDATE SET invoice_code=EXCLUDED.invoice_code,order_code=EXCLUDED.order_code,status=EXCLUDED.status,indexed_at=now()
      RETURNING 1)
    SELECT advanced.*,(SELECT count(*) FROM saved)::int AS saved_count FROM advanced`,
    [
      state.generation, offset, next.scanned, next.lastInvoiceId, next.total, next.current, next.startedAt.toISOString(),
      invoices.map((invoice) => Number(invoice.id)), invoices.map((invoice) => invoice.code ?? ""),
      invoices.map((invoice) => invoice.orderCode || null), invoices.map((invoice) => (invoice.status == null ? null : Number(invoice.status))),
    ],
  );
}

/**
 * Runs scheduled index maintenance at most once at a time across workers. A run
 * that finds the lease taken is skipped (null): BullMQ may start the next
 * repetition while a slow one is still paging. The lease expires on its own if
 * a worker dies. Lookups do not take the lease (their writes are optimistic).
 */
export async function withInvoiceIndexLease<T>(owner: string, work: () => Promise<T>, leaseSeconds = 120): Promise<T | null> {
  const acquired = await query(
    `UPDATE kiotviet_invoice_index_state SET lease_owner=$1,lease_until=now()+make_interval(secs=>$2)
    WHERE id=1 AND (lease_until IS NULL OR lease_until<now()) RETURNING id`,
    [owner, leaseSeconds],
  );
  if (!acquired.length) return null;
  try {
    return await work();
  } finally {
    await query("UPDATE kiotviet_invoice_index_state SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=$1", [owner]);
  }
}

/** Newest-first pages a floor scan may read before falling back to the index (≈ 500 invoices). */
export const FLOOR_SCAN_MAX_PAGES = 5;

/**
 * Independent proof of absence for an order this app created, used instead of
 * waiting for the index. order_mappings.invoice_id_floor is the highest invoice
 * id this app had seen before creating the KiotViet order, so (ids are
 * allocated increasingly, the same assumption the index relies on) every
 * invoice of that order has a larger id. Reading invoices newest-first until an
 * id ≤ floor therefore sees all of them. Each page re-reads the previous page's
 * last invoice (overlap of 1) and ids must strictly decrease, so an insert,
 * delete or ignored ordering during the scan makes it inconclusive, never complete.
 */
export async function scanInvoicesAboveFloor(floorId: number, options: { maxPages?: number } = {}) {
  const maxPages = options.maxPages ?? FLOOR_SCAN_MAX_PAGES;
  const invoices: KiotVietInvoice[] = [];
  let offset = 0, lastId: number | null = null, pages = 0;
  const incomplete = (error: string) => ({ complete: false as const, invoices, pages, error: `floor scan: ${error}` });
  while (pages < maxPages) {
    const overlap = lastId === null ? 0 : 1;
    let page: KiotVietInvoicesResponse;
    try {
      page = await countedGet<KiotVietInvoicesResponse>(`/invoices?${new URLSearchParams({
        orderBy: "id", orderDirection: "Desc", pageSize: String(INVOICE_INDEX_PAGE_SIZE), currentItem: String(offset - overlap),
      })}`, { timeoutMs: 10_000, maxAttempts: 2 });
    } catch (error) {
      return incomplete(error instanceof Error ? error.message : String(error));
    }
    pages++;
    const total = Number(page?.total);
    const data = Array.isArray(page?.data) ? page.data : null;
    if (!data || !Number.isSafeInteger(total) || total < 0) return incomplete("malformed invoice page");
    if (overlap && Number(data[0]?.id) !== lastId) return incomplete("invoices changed during the scan");
    const fresh = data.slice(overlap);
    // The whole page must be strictly newest-first before the floor may stop the scan:
    // an ascending page would otherwise "prove" absence from its very first (oldest) id.
    let previous = lastId ?? Number.POSITIVE_INFINITY;
    for (const invoice of fresh) {
      const id = Number(invoice.id);
      if (!Number.isSafeInteger(id) || id >= previous) return incomplete("orderBy=id Desc not honored");
      previous = id;
    }
    for (const invoice of fresh) {
      const id = Number(invoice.id);
      if (id <= floorId) return { complete: true as const, invoices, pages };
      invoices.push(invoice);
      lastId = id;
    }
    offset += fresh.length;
    if (offset >= total) return { complete: true as const, invoices, pages }; // every remote invoice is above the floor and was read
    if (!fresh.length) return incomplete("page made no progress");
  }
  return incomplete(`more than ${maxPages * INVOICE_INDEX_PAGE_SIZE} invoices above the floor`);
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

export type IndexFreshness = "reused" | "joined" | "queued" | "fetched";

type Refresh = { startedAt: Promise<Date>; promise: Promise<InvoiceIndexProgress> };
let inflight: Refresh | null = null;
let queued: Promise<InvoiceIndexProgress> | null = null;

function startRefresh(options: { maxPages?: number; deadlineMs?: number }): Refresh {
  // Registered synchronously so lookups running in lockstep join instead of racing.
  const startedAt = dbNow();
  const promise = startedAt.then(() => advanceInvoiceIndex({ maxPages: options.maxPages ?? 10, deadlineMs: options.deadlineMs ?? 25_000 }));
  const refresh = { startedAt, promise };
  inflight = refresh;
  promise.finally(() => { if (inflight === refresh) inflight = null; }).catch(() => undefined);
  return refresh;
}

/**
 * Proves the index holds every invoice that existed when `lookupStart` began, with
 * as few KiotViet requests as possible:
 * - reused (0 requests): another job or worker already confirmed the index current
 *   with a request that started at or after lookupStart (current_as_of, DB clock);
 * - joined (0 requests): an in-process confirmation that started after lookupStart
 *   is awaited instead of sending a parallel one;
 * - queued: a confirmation that started too early cannot be used, so one refresh is
 *   queued behind it and shared by every lookup that arrives meanwhile (instead of
 *   one parallel request each);
 * - fetched (usually 1 request): re-read the tail page (overlap of 1).
 * An older confirmation is never reused: it cannot cover invoices created since.
 * `knownState` (read together with the lookup's clock) saves a round trip.
 */
export async function ensureIndexFresh(lookupStart: Date, options: { maxPages?: number; deadlineMs?: number } = {}, knownState?: InvoiceIndexState) {
  const judge = (progress: InvoiceIndexProgress, freshness: IndexFreshness) => {
    // Whatever path delivered it, only a confirmation that started at/after lookupStart counts.
    const complete = progress.current && progress.currentAsOf !== null && progress.currentAsOf.getTime() >= lookupStart.getTime();
    return { complete, freshness, progress, error: complete ? undefined : progress.error ?? `invoice index not current (${progress.scanned}/${progress.total ?? "?"} indexed)` };
  };
  const state = knownState ?? await getInvoiceIndexState();
  const asOf = asDate(state.current_as_of);
  if (asOf && asOf.getTime() >= lookupStart.getTime() && state.remote_total !== null && state.scanned_count >= state.remote_total)
    return judge({ current: true, currentAsOf: asOf, scanned: state.scanned_count, total: state.remote_total, pages: 0 }, "reused");
  const running = inflight;
  if (running) {
    if ((await running.startedAt).getTime() >= lookupStart.getTime()) return judge(await running.promise, "joined");
    if (!queued) {
      const next = running.promise.catch(() => undefined).then(() => { queued = null; return startRefresh(options).promise; });
      queued = next;
    }
    return judge(await queued, "queued");
  }
  return judge(await startRefresh(options).promise, "fetched");
}

/**
 * The local (PostgreSQL-only) step of a duplicate lookup in one round trip: the
 * database clock (the lookup's start), the index checkpoint, and the candidate
 * invoices (recorded by this app in invoice_mappings, by kiotviet_order_id or code,
 * and held by the index for the code). Candidates are never proof of absence.
 * Plan: BitmapOr over invoice_mappings_kiotviet_order_id_key + _kiotviet_order_code_idx
 * and kiotviet_invoice_index_order_code_idx (migrations 007/009/012). Replaces three
 * statements (measured ~2× faster in-process; saves two network round trips).
 */
export async function localLookupSnapshot(order: { id: number; code: string }) {
  const [row] = await query<InvoiceIndexState & { db_now: string | Date; candidates: string[] | null }>(
    `SELECT clock_timestamp() AS db_now,s.scanned_count,s.last_invoice_id::text,s.remote_total,s.current_as_of,s.generation,s.last_error,
      ARRAY(SELECT kiotviet_invoice_id FROM invoice_mappings
          WHERE kiotviet_invoice_id IS NOT NULL AND (kiotviet_order_id=$1 OR kiotviet_order_code=$2)
        UNION SELECT invoice_id FROM kiotviet_invoice_index WHERE order_code=$2)::text[] AS candidates
    FROM kiotviet_invoice_index_state s WHERE s.id=1`,
    [order.id, order.code],
  );
  if (!row) throw new Error("kiotviet_invoice_index_state is missing; run migration 009");
  const { db_now, candidates, ...state } = row;
  const lookupStart = new Date(db_now);
  // Every freshness comparison depends on this instant; never continue with an invalid one.
  if (!Number.isFinite(lookupStart.getTime())) throw new Error("invalid database clock in the invoice lookup snapshot");
  return { lookupStart, state: state as InvoiceIndexState, candidates: (candidates ?? []).map(Number) };
}

export async function indexedInvoicesForOrder(orderCode: string) {
  return query<{ invoice_id: string; invoice_code: string; order_code: string; status: number | null }>(
    "SELECT invoice_id::text,invoice_code,order_code,status FROM kiotviet_invoice_index WHERE order_code=$1",
    [orderCode],
  );
}
