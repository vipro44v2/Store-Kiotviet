import { beforeEach, describe, expect, it, vi } from "vitest";

interface State { scanned_count: number; last_invoice_id: string | null; remote_total: number | null; current_as_of: string | null; generation: number; last_error: string | null }
const m = vi.hoisted(() => ({
  get: vi.fn(),
  state: undefined as unknown as State,
  index: new Map<number, { invoice_code: string; order_code: string | null; status: number | null }>(),
  remote: [] as Array<{ id: number; code: string; orderCode?: string; status: number }>,
  ignoreOrderBy: false,
  failAfter: Infinity,
  calls: 0,
  repositions: 0,
  pageWrites: 0,
  snapshots: 0,
  failPageWrite: false,
  sql: [] as string[],
  hintMode: "none" as "none" | "ignored",
  appInvoices: [] as Array<{ invoice_id: number; order_code: string }>,
  filterEvidence: undefined as Record<string, unknown> | undefined,
  lease: undefined as { owner: string; until: number } | undefined,
  onPage: undefined as ((params: URLSearchParams) => void) | undefined,
}));

vi.mock("@/lib/db/client", () => ({
  query: async (sql: string, params: unknown[] = []) => {
    const s = m.state;
    m.sql.push(sql);
    if (sql.startsWith("DELETE FROM kiotviet_invoice_index")) { m.index.delete(Number(params[0])); return []; }
    if (sql === "SELECT clock_timestamp() AS now") return [{ now: new Date() }];
    if (sql.startsWith("SELECT clock_timestamp() AS db_now")) {
      m.snapshots++;
      const candidates = [...new Set([...m.appInvoices.filter((row) => row.order_code === params[1]).map((row) => String(row.invoice_id)),
        ...[...m.index].filter(([, row]) => row.order_code === params[1]).map(([id]) => String(id))])];
      return [{ db_now: new Date(), ...s, candidates }];
    }
    if (sql.startsWith("SELECT value FROM system_settings")) return m.filterEvidence ? [{ value: m.filterEvidence }] : [];
    if (sql.startsWith("SELECT scanned_count")) return [{ ...s }];
    if (sql.startsWith("UPDATE kiotviet_invoice_index_state SET scanned_count=0")) {
      if (s.generation !== params[0]) return [];
      Object.assign(s, { scanned_count: 0, last_invoice_id: null, remote_total: null, current_as_of: null, generation: s.generation + 1, last_error: params[1] });
      return [];
    }
    if (sql.startsWith("UPDATE kiotviet_invoice_index_state SET lease_owner=$1")) {
      if (m.lease && m.lease.until > Date.now()) return [];
      m.lease = { owner: String(params[0]), until: Date.now() + Number(params[1]) * 1000 };
      return [{ id: 1 }];
    }
    if (sql.startsWith("UPDATE kiotviet_invoice_index_state SET lease_owner=NULL")) {
      if (m.lease?.owner === params[0]) m.lease = undefined;
      return [];
    }
    if (sql.includes("reposition_count=reposition_count+1")) {
      if (s.generation !== params[0] || s.scanned_count !== params[1]) return [];
      Object.assign(s, { scanned_count: params[2], last_invoice_id: params[3] == null ? null : String(params[3]), remote_total: params[4], last_error: params[5] });
      m.repositions++;
      return [{ id: 1 }];
    }
    if (sql.startsWith("UPDATE kiotviet_invoice_index_state SET last_error")) {
      if (s.generation === params[0]) s.last_error = String(params[1]);
      return [];
    }
    if (sql.startsWith("WITH advanced AS (")) {
      m.pageWrites++;
      if (m.failPageWrite) { m.failPageWrite = false; throw new Error("connection terminated (worker crash)"); }
      if (s.generation !== params[0] || s.scanned_count !== params[1]) return [];
      const ids = params[7] as number[], codes = params[8] as string[], orders = params[9] as Array<string | null>, statuses = params[10] as Array<number | null>;
      ids.forEach((id, i) => m.index.set(Number(id), { invoice_code: codes[i], order_code: orders[i], status: statuses[i] }));
      Object.assign(s, { scanned_count: params[2], last_invoice_id: params[3] == null ? null : String(params[3]), remote_total: params[4], current_as_of: params[5] ? params[6] : s.current_as_of, last_error: null });
      return [{ ...s, saved_count: new Set(ids).size }];
    }
    if (sql.startsWith("UPDATE kiotviet_invoice_index_state SET scanned_count=$3")) {
      if (s.generation !== params[0] || s.scanned_count !== params[1]) return [];
      Object.assign(s, { scanned_count: params[2], last_invoice_id: params[3] == null ? null : String(params[3]), remote_total: params[4], current_as_of: params[5] ? params[6] : s.current_as_of, last_error: null });
      return [{ ...s }];
    }
    if (sql.startsWith("INSERT INTO kiotviet_invoice_index")) {
      m.index.set(Number(params[0]), { invoice_code: String(params[1]), order_code: params[2] as string | null, status: params[3] as number | null });
      return [];
    }
    if (sql.includes("FROM kiotviet_invoice_index WHERE order_code=$1"))
      return [...m.index].filter(([, row]) => row.order_code === params[0]).map(([id, row]) => ({ invoice_id: String(id), ...row }));
    throw new Error(`Unhandled SQL ${sql.slice(0, 60)}`);
  },
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietClient: { get: m.get } }));

import { advanceInvoiceIndex, withInvoiceIndexLease } from "@/lib/kiotviet/invoice-index";
import { findKiotVietInvoicesForOrder } from "@/lib/kiotviet/invoices";

/** Simulated GET /invoices honoring orderBy=id&orderDirection=Asc and currentItem/pageSize. */
function serve(url: string) {
  m.calls++;
  if (m.calls > m.failAfter) throw new Error("timeout");
  const params = new URL(url, "https://x").searchParams;
  if (url.startsWith("/invoices/")) {
    const invoice = m.remote.find((item) => item.id === Number(url.split("/")[2]));
    return invoice;
  }
  // The orderId filter: "none" finds nothing; "ignored" returns every invoice (filter not applied).
  if (params.has("orderId")) return m.hintMode === "ignored" ? { total: m.remote.length, data: m.remote.slice(0, 100) } : { total: 0, data: [] };
  const ascending = m.ignoreOrderBy ? [...m.remote].reverse() : [...m.remote].sort((a, b) => a.id - b.id);
  const sorted = params.get("orderDirection") === "Desc" && !m.ignoreOrderBy ? ascending.reverse() : ascending;
  m.onPage?.(params);
  const start = Number(params.get("currentItem")), size = Number(params.get("pageSize"));
  return { total: m.remote.length, pageSize: size, data: sorted.slice(start, start + size) };
}
const invoices = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, code: `HD${from + i}`, orderCode: `DH${from + i}`, status: 1 }));

beforeEach(() => {
  m.state = { scanned_count: 0, last_invoice_id: null, remote_total: null, current_as_of: null, generation: 1, last_error: null };
  m.index.clear();
  m.remote = invoices(13_215);
  m.ignoreOrderBy = false;
  m.failAfter = Infinity;
  m.calls = 0;
  m.repositions = 0;
  m.pageWrites = 0;
  m.snapshots = 0;
  m.failPageWrite = false;
  m.sql = [];
  m.hintMode = "none";
  m.appInvoices = [];
  m.filterEvidence = undefined;
  m.lease = undefined;
  m.onPage = undefined;
  m.get.mockReset().mockImplementation(async (url: string) => serve(url));
});

describe("KiotViet invoice index (13,215 invoices)", () => {
  it("builds resumably in ascending id order and becomes current", async () => {
    const first = await advanceInvoiceIndex({ maxPages: 50 });
    // First page 100 invoices, then 99 new per page because of the overlap.
    expect(first).toMatchObject({ current: false, scanned: 100 + 49 * 99 });
    const done = await advanceInvoiceIndex({ maxPages: 200 });
    expect(done).toMatchObject({ current: true, scanned: 13_215, total: 13_215 });
    expect(m.index.size).toBe(13_215);
    // Pages after the first re-read the last indexed invoice (overlap of 1).
    expect(m.get.mock.calls[1][0]).toContain("currentItem=99");
  });

  it("appends invoices created later with one cheap incremental request", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.remote.push({ id: 20_000, code: "HD20000", orderCode: "DH1072", status: 1 });
    m.get.mockClear();
    await expect(advanceInvoiceIndex()).resolves.toMatchObject({ current: true, scanned: 13_216, pages: 1 });
    expect(m.index.get(20_000)).toMatchObject({ order_code: "DH1072" });
  });

  it("repositions by binary search (no full rebuild) when an already indexed invoice disappears", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.remote = m.remote.filter((invoice) => invoice.id !== 13_215 && invoice.id !== 500);
    m.remote.push({ id: 30_000, code: "HD30000", orderCode: "DH9", status: 1 });
    m.calls = 0;
    const progress = await advanceInvoiceIndex({ maxPages: 3 });
    expect(progress).toMatchObject({ current: true, scanned: 13_214, total: 13_214 });
    expect(m.state).toMatchObject({ generation: 1, last_invoice_id: "30000" });
    expect(m.repositions).toBe(1);
    expect(m.calls).toBeLessThan(25); // ~log2(13k) single-row reads, never ~133 pages
    expect(m.index.get(30_000)).toMatchObject({ order_code: "DH9" });
  });

  it("repositions mid-build after deletions and still indexes every remaining invoice", async () => {
    await advanceInvoiceIndex({ maxPages: 20 });
    m.remote = m.remote.filter((invoice) => invoice.id % 97 !== 0 || invoice.id > 5_000);
    await expect(advanceInvoiceIndex({ maxPages: 300 })).resolves.toMatchObject({ current: true, total: m.remote.length });
    expect(m.remote.every((invoice) => m.index.has(invoice.id))).toBe(true);
    expect(m.state.generation).toBe(1);
  });

  it("never claims completeness when the reposition itself fails", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    const before = m.state.current_as_of;
    m.remote = m.remote.filter((invoice) => invoice.id !== 100);
    m.failAfter = m.calls + 3;
    const progress = await advanceInvoiceIndex({ maxPages: 3 });
    expect(progress).toMatchObject({ current: false, error: expect.stringContaining("reposition failed") });
    expect(m.state).toMatchObject({ scanned_count: 13_215, current_as_of: before, last_error: expect.stringContaining("overlap mismatch") });
    // The next scheduler run (API healthy again) recovers on its own.
    m.failAfter = Infinity;
    await expect(advanceInvoiceIndex({ maxPages: 3 })).resolves.toMatchObject({ current: true, scanned: 13_214 });
  });

  it("proves absence again after a reposition only with a fresh confirmation", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.remote = m.remote.filter((invoice) => invoice.id !== 7);
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NOT-INVOICED" });
    expect(result).toMatchObject({ invoices: [], complete: true, method: "index" });
    await expect(findKiotVietInvoicesForOrder({ id: 1, code: "DH7" })).resolves.toMatchObject({ invoices: [] });
  });

  it("refuses to use the index when KiotViet ignores orderBy=id", async () => {
    m.ignoreOrderBy = true;
    const progress = await advanceInvoiceIndex({ maxPages: 3 });
    expect(progress).toMatchObject({ current: false, error: expect.stringContaining("orderBy=id not honored") });
    expect(m.state.current_as_of).toBeNull();
  });

  it("stops without claiming completeness when a page times out", async () => {
    m.failAfter = 3;
    await expect(advanceInvoiceIndex({ maxPages: 200 })).resolves.toMatchObject({ current: false, error: "timeout", scanned: 300 - 2 + 0 });
  });
});

describe("findKiotVietInvoicesForOrder", () => {
  it("proves absence for a retailer with 13,215 invoices once the index is current", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NOT-INVOICED" });
    expect(result).toMatchObject({ invoices: [], complete: true, method: "index" });
  });

  it("finds an existing invoice by orderCode and re-reads its current status", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.remote.find((invoice) => invoice.id === 42)!.status = 2;
    const result = await findKiotVietInvoicesForOrder({ id: 1, code: "DH42" });
    expect(result).toMatchObject({ complete: true, invoices: [{ id: 42, code: "HD42", orderCode: "DH42", status: 2 }] });
  });

  it("is incomplete (never proof of absence) while the index is still being built", async () => {
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NOT-INVOICED" }, undefined, { maxIndexPages: 5 });
    expect(result.complete).toBe(false);
    expect(result.indexError).toContain("not current");
  });

  it("is incomplete when the index was current only before the lookup started", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.state.current_as_of = new Date(Date.now() - 60_000).toISOString(); // confirmed only before this lookup
    m.failAfter = m.calls; // the freshness request fails
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NOT-INVOICED" });
    expect(result.complete).toBe(false);
  });
});

describe("floor scan: duplicate check without waiting for the index", () => {
  const listCalls = () => m.get.mock.calls.filter(([url]) => String(url).includes("orderDirection=Desc")).length;

  it("proves absence for a new order with one request while the index is still empty", async () => {
    // Index never built (e.g. right after a reset); the order's floor is invoice 13,200.
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW", invoiceIdFloor: 13_200 });
    expect(result).toMatchObject({ invoices: [], complete: true, method: "floor_scan" });
    expect(listCalls()).toBe(1);
    expect(m.get.mock.calls.some(([url]) => String(url).includes("orderDirection=Asc"))).toBe(false);
  });

  it("finds the order's invoice above the floor and re-reads its status", async () => {
    m.remote.push({ id: 20_001, code: "HD20001", orderCode: "DH-NEW", status: 1 });
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW", invoiceIdFloor: 13_200 });
    expect(result).toMatchObject({ complete: true, method: "floor_scan", invoices: [{ id: 20_001, code: "HD20001" }] });
  });

  it("is never complete when invoices are inserted during the scan (page overlap shifts)", async () => {
    m.onPage = (params) => {
      if (params.get("orderDirection") === "Desc" && params.get("currentItem") === "0")
        m.remote.push({ id: 30_000 + m.remote.length, code: "HDX", orderCode: "DH-OTHER", status: 1 });
    };
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW", invoiceIdFloor: 13_000 }, undefined, { maxIndexPages: 1 });
    expect(result.complete).toBe(false);
    expect(result.indexError).toContain("floor scan: invoices changed during the scan");
  });

  it("is never complete when KiotViet ignores the ordering", async () => {
    // KiotViet answers a Desc request in ascending order.
    m.get.mockImplementation(async (url: string) => serve(url.replace("orderDirection=Desc", "orderDirection=Asc")));
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW", invoiceIdFloor: 13_000 }, undefined, { maxIndexPages: 1 });
    expect(result.complete).toBe(false);
    expect(result.indexError).toContain("floor scan");
  });

  it("falls back to the index when too many invoices are above the floor", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-OLD", invoiceIdFloor: 10 });
    expect(result).toMatchObject({ complete: true, method: "index" });
  });
});

describe("scheduled index runs", () => {
  it("never overlap: a second run while one holds the lease is skipped, and the lease is released", async () => {
    let release!: () => void;
    const first = withInvoiceIndexLease("run-1", () => new Promise<string>((resolve) => { release = () => resolve("done"); }));
    await vi.waitFor(() => expect(m.lease?.owner).toBe("run-1"));
    await expect(withInvoiceIndexLease("run-2", async () => "second")).resolves.toBeNull();
    release();
    await expect(first).resolves.toBe("done");
    await expect(withInvoiceIndexLease("run-3", async () => "third")).resolves.toBe("third");
  });
});

describe("fast duplicate lookup", () => {
  const urls = () => m.get.mock.calls.map(([url]) => String(url));
  const listCalls = () => urls().filter((url) => url.startsWith("/invoices?")).length;
  beforeEach(async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    // Confirmed before each test lookup starts (same-millisecond reuse is valid but makes tests timing-dependent).
    m.state.current_as_of = new Date(Date.now() - 1_000).toISOString();
    m.get.mockClear();
  });

  it("normal path: local candidates + one freshness request, no detail reads, no orderId request", async () => {
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" });
    expect(result).toMatchObject({ invoices: [], complete: true, method: "index",
      metrics: { method: "index", freshness: "fetched", apiCalls: 1, candidates: 0, indexLag: 0 } });
    expect(urls()).toEqual([expect.stringContaining("orderDirection=Asc")]);
    expect(urls().some((url) => url.includes("orderId="))).toBe(false);
    expect(result.metrics!.localMs).toBeLessThan(1000);
    expect(result.metrics!.totalMs).toBeGreaterThanOrEqual(result.metrics!.localMs);
  });

  it("concurrent jobs share one freshness request", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => findKiotVietInvoicesForOrder({ id: 6000 + i, code: `DH-C${i}` })));
    expect(results.every((result) => result.complete)).toBe(true);
    expect(listCalls()).toBe(1);
    expect(results.filter((result) => result.metrics?.freshness === "joined")).toHaveLength(7);
    expect(results.reduce((sum, result) => sum + (result.metrics?.apiCalls ?? 0), 0)).toBe(1);
  });

  it("reuses a confirmation another worker made after this lookup began (0 requests)", async () => {
    m.state.current_as_of = new Date(Date.now() + 60_000).toISOString();
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" });
    expect(result).toMatchObject({ complete: true, metrics: { freshness: "reused", apiCalls: 0 } });
    expect(m.get).not.toHaveBeenCalled();
  });

  it("never reuses a confirmation older than the lookup (stale index)", async () => {
    m.state.current_as_of = new Date(Date.now() - 1_000).toISOString();
    m.remote.push({ id: 20_000, code: "HD20000", orderCode: "DH-NEW", status: 1 });
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" });
    // The fresh request found the invoice created after the old confirmation.
    expect(result).toMatchObject({ complete: true, invoices: [{ id: 20_000 }], metrics: { freshness: "fetched" } });
  });

  it("finds invoices the app recorded in invoice_mappings without any remote search", async () => {
    m.appInvoices = [{ invoice_id: 42, order_code: "DH42" }];
    const result = await findKiotVietInvoicesForOrder({ id: 42, code: "DH42" });
    expect(result).toMatchObject({ complete: true, invoices: [{ id: 42 }] });
    expect(urls().filter((url) => url.startsWith("/invoices/"))).toEqual(["/invoices/42"]);
  });

  it("an orderId filter returning other orders' invoices is never proof and never a false match", async () => {
    m.hintMode = "ignored";
    m.get.mockImplementation(async (url: string) => {
      if (url.includes("orderId=")) return serve(url);
      throw new Error("timeout"); // the index cannot be confirmed
    });
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" });
    expect(result).toMatchObject({ complete: false, invoices: [] });
    expect(result.indexError).toContain("timeout");
  });

  it("skips the orderId request entirely once verification showed KiotViet ignores the filter", async () => {
    m.filterEvidence = { result: "ignored" };
    m.get.mockImplementation(async () => { throw new Error("timeout"); });
    await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" });
    expect(urls().some((url) => url.includes("orderId="))).toBe(false);
  });

  it("an invoice missing from KiotViet (404 on re-read) is dropped, not reported as a duplicate", async () => {
    m.appInvoices = [{ invoice_id: 77_777, order_code: "DH-NEW" }];
    const { ApiError } = await import("@/lib/errors");
    m.get.mockImplementation(async (url: string) => {
      if (url === "/invoices/77777") throw new ApiError("KiotViet API error (404): not found", 404);
      return serve(url);
    });
    await expect(findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" })).resolves.toMatchObject({ complete: true, invoices: [] });
  });
});

describe("index page writes (batch UPSERT + checkpoint, one statement)", () => {
  it("writes each page with one statement that carries every invoice of the page", async () => {
    await advanceInvoiceIndex({ maxPages: 3 });
    expect(m.pageWrites).toBe(3);
    expect(m.sql.filter((sql) => sql.startsWith("INSERT INTO kiotviet_invoice_index"))).toHaveLength(0);
    expect(m.index.size).toBe(100 + 99 + 99);
    expect(m.state).toMatchObject({ scanned_count: 298, last_invoice_id: "298" });
    expect(m.index.get(150)).toMatchObject({ invoice_code: "HD150", order_code: "DH150", status: 1 });
  });

  it("a crash during the page write leaves checkpoint and rows unchanged; the next run resumes exactly", async () => {
    await advanceInvoiceIndex({ maxPages: 2 });
    const before = { ...m.state }, indexed = m.index.size;
    m.failPageWrite = true;
    await expect(advanceInvoiceIndex({ maxPages: 1 })).rejects.toThrow("worker crash");
    expect(m.state).toEqual(before);
    expect(m.index.size).toBe(indexed);
    await expect(advanceInvoiceIndex({ maxPages: 200 })).resolves.toMatchObject({ current: true, scanned: 13_215 });
    expect(m.index.size).toBe(13_215);
  });

  it("concurrent index runners never corrupt progress (guarded checkpoint, rows only with it)", async () => {
    const results = await Promise.all([advanceInvoiceIndex({ maxPages: 200 }), advanceInvoiceIndex({ maxPages: 200 }), advanceInvoiceIndex({ maxPages: 200 })]);
    expect(results.some((result) => result.current)).toBe(true);
    expect(m.state).toMatchObject({ scanned_count: 13_215, remote_total: 13_215, last_invoice_id: "13215", generation: 1 });
    expect(m.index.size).toBe(13_215);
    expect(m.remote.every((invoice) => m.index.has(invoice.id))).toBe(true);
  });

  it("stores cancelled invoices with their status (the lookup re-reads candidates anyway)", async () => {
    m.remote[4].status = 2;
    await advanceInvoiceIndex({ maxPages: 1 });
    expect(m.index.get(5)).toMatchObject({ status: 2 });
  });

  it("the tail check on a current index writes no invoice rows when nothing is new", async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.pageWrites = 0;
    await advanceInvoiceIndex({ maxPages: 1 });
    expect(m.pageWrites).toBe(1); // checkpoint (current_as_of) only, empty batch
    expect(m.index.size).toBe(13_215);
  });
});

describe("lookup round trips and refresh sharing", () => {
  const listCalls = () => m.get.mock.calls.filter(([url]) => String(url).startsWith("/invoices?orderBy")).length;
  beforeEach(async () => {
    await advanceInvoiceIndex({ maxPages: 200 });
    m.state.current_as_of = new Date(Date.now() - 1_000).toISOString();
    m.get.mockClear();
    m.sql = [];
  });

  it("the local step is one statement (clock + checkpoint + candidates)", async () => {
    await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NEW" });
    expect(m.snapshots).toBe(1);
    // The local step is the first statement; nothing else is read before the freshness refresh.
    expect(m.sql[0].startsWith("SELECT clock_timestamp() AS db_now")).toBe(true);
    // No extra index candidate query when the freshness check appended nothing.
    expect(m.sql.some((sql) => sql.includes("FROM kiotviet_invoice_index WHERE order_code=$1"))).toBe(false);
  });

  it("lookups that start during an older refresh share one queued refresh (2 requests, not 3)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    m.get.mockImplementation(async (url: string) => {
      if (first && url.includes("orderDirection=Asc")) { first = false; await gate; }
      return serve(url);
    });
    const a = findKiotVietInvoicesForOrder({ id: 1, code: "DH-A" });
    await vi.waitFor(() => expect(listCalls()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5)); // B and C begin after A's refresh started
    const b = findKiotVietInvoicesForOrder({ id: 2, code: "DH-B" });
    const c = findKiotVietInvoicesForOrder({ id: 3, code: "DH-C" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const results = await Promise.all([a, b, c]);
    expect(results.every((result) => result.complete)).toBe(true);
    expect(results.map((result) => result.metrics?.freshness)).toEqual(["fetched", "queued", "queued"]);
    expect(listCalls()).toBe(2);
  });

  it("an invoice created during the older refresh is still found by the queued one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    m.get.mockImplementation(async (url: string) => {
      if (first && url.includes("orderDirection=Asc")) { first = false; const page = serve(url); await gate; return page; }
      return serve(url);
    });
    const a = findKiotVietInvoicesForOrder({ id: 1, code: "DH-A" });
    await vi.waitFor(() => expect(listCalls()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    m.remote.push({ id: 20_500, code: "HD20500", orderCode: "DH-LATE", status: 1 }); // created after A's page was read
    const late = findKiotVietInvoicesForOrder({ id: 9, code: "DH-LATE" });
    release();
    await a;
    await expect(late).resolves.toMatchObject({ complete: true, invoices: [{ id: 20_500 }], metrics: { freshness: "queued" } });
  });
});
