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
}));

vi.mock("@/lib/db/client", () => ({
  query: async (sql: string, params: unknown[] = []) => {
    const s = m.state;
    if (sql.startsWith("SELECT scanned_count")) return [{ ...s }];
    if (sql.startsWith("UPDATE kiotviet_invoice_index_state SET scanned_count=0")) {
      if (s.generation !== params[0]) return [];
      Object.assign(s, { scanned_count: 0, last_invoice_id: null, remote_total: null, current_as_of: null, generation: s.generation + 1, last_error: params[1] });
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

import { advanceInvoiceIndex } from "@/lib/kiotviet/invoice-index";
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
  if (params.has("orderId")) return { total: 0, data: [] }; // the ambiguous filter finds nothing
  const sorted = m.ignoreOrderBy ? [...m.remote].reverse() : [...m.remote].sort((a, b) => a.id - b.id);
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
    expect(result).toEqual({ invoices: [], complete: true });
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
    await expect(findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NOT-INVOICED" })).resolves.toEqual({ invoices: [], complete: true });
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
    m.failAfter = m.calls + 1; // the orderId hint succeeds, the freshness request fails
    const result = await findKiotVietInvoicesForOrder({ id: 5555, code: "DH-NOT-INVOICED" });
    expect(result.complete).toBe(false);
  });
});
