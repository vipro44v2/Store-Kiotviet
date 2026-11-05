import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KiotVietReturn } from "@/lib/kiotviet/types";

interface Row {
  kiotviet_return_id: number; kiotviet_return_code: string; shopify_order_id: string; status: string | null;
  claim_token: string | null; claimed_at: Date | null; sent_at: Date | null; financial_refund_id: string | null;
  shopify_refund_id: string | null; amount: string | null; attempt_count: number; idempotency_key: string | null;
  request: unknown; response: unknown; source: string | null; last_error: string | null; failure_stage: string | null; updated_at: Date;
}
type Refund = { id: string; note?: string; createdAt?: string; totalRefundedSet?: { shopMoney: { amount: string } }; refundLineItems: { nodes: Array<{ quantity: number; lineItem: { id: string; sku?: string } }> } };

const m = vi.hoisted(() => ({
  rows: new Map<number, Row>(),
  returns: new Map<number, KiotVietReturn>(),
  refunds: [] as Refund[],
  lines: [] as Array<{ id: string; sku?: string; refundableQuantity: number }>,
  available: 1000,
  create: vi.fn(),
  failWrite: undefined as string | undefined,
  enqueue: vi.fn(),
  log: vi.fn(),
  sql: [] as string[],
  cursor: undefined as string | undefined,
  page: [] as KiotVietReturn[],
}));

function run(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  m.sql.push(sql);
  if (m.failWrite && sql.includes(m.failWrite)) { m.failWrite = undefined; throw new Error("connection terminated (database failure)"); }
  const id = Number(params[0]);
  const row = m.rows.get(id);
  if (sql.includes("pg_advisory_xact_lock")) return [];
  if (sql.startsWith("SELECT shopify_order_id,kiotviet_order_id FROM order_mappings")) return [{ shopify_order_id: "7001", kiotviet_order_id: "501" }];
  if (sql.startsWith("SELECT status,claim_token")) return row ? [{ ...row, amount: row.amount }] : [];
  if (sql.startsWith("INSERT INTO refund_mappings")) {
    const row = m.rows.get(Number(params[2])); // keyed by the KiotViet return id
    if (row && (row.financial_refund_id || row.status === "financial_refunded" || row.status === "needs_review")) return [];
    m.rows.set(Number(params[2]), {
      ...(row ?? { financial_refund_id: null, shopify_refund_id: null, amount: null, attempt_count: 0, request: null, response: null, source: null, last_error: null, failure_stage: null, sent_at: null }),
      kiotviet_return_id: Number(params[2]), kiotviet_return_code: String(params[3]), shopify_order_id: String(params[0]),
      status: row?.status === "sending" ? "sending" : "processing", claim_token: String(params[6]), claimed_at: new Date(),
      attempt_count: (row?.attempt_count ?? 0) + 1, idempotency_key: row?.idempotency_key ?? String(params[5]), updated_at: new Date(),
    } as Row);
    return [{ kiotviet_return_id: params[2] }];
  }
  if (sql.startsWith("SELECT financial_refund_id FROM refund_mappings WHERE shopify_order_id=$1"))
    return [...m.rows.values()].filter((other) => other.shopify_order_id === params[0] && other.financial_refund_id && other.kiotviet_return_id !== Number(params[1]))
      .map((other) => ({ financial_refund_id: other.financial_refund_id }));
  if (!row) {
    if (sql.startsWith("SELECT value FROM system_settings")) return m.cursor ? [{ value: { lastModifiedFrom: m.cursor } }] : [];
    if (sql.startsWith("INSERT INTO system_settings")) return [];
    if (sql.startsWith("SELECT 1 FROM refund_mappings")) return [];
    if (sql.startsWith("SELECT kiotviet_return_id::text,attempt_count")) return stuckRows();
    if (sql.startsWith("UPDATE refund_mappings")) return [];
    throw new Error(`Unhandled SQL: ${sql.slice(0, 70)}`);
  }
  const owns = row.claim_token !== null && row.claim_token === params[1];
  if (sql.startsWith("UPDATE refund_mappings SET status=$3")) {
    if (!owns) return [];
    Object.assign(row, { status: params[2], claim_token: null, last_error: params[3], failure_stage: params[4],
      financial_refund_id: params[5] ?? row.financial_refund_id, shopify_refund_id: params[5] ?? row.shopify_refund_id,
      response: params[6] ? JSON.parse(String(params[6])) : row.response, source: params[7] ?? row.source, updated_at: new Date() });
    return [];
  }
  if (sql.startsWith("UPDATE refund_mappings SET amount=COALESCE")) { if (owns) row.amount = row.amount ?? String(params[2]); return []; }
  if (sql.startsWith("UPDATE refund_mappings SET status='sending'")) {
    if (!owns || row.status !== "processing") return [];
    Object.assign(row, { status: "sending", request: JSON.parse(String(params[2])), amount: String(params[3]), sent_at: new Date(), updated_at: new Date() });
    return [{ kiotviet_return_id: id }];
  }
  if (sql.startsWith("UPDATE refund_mappings SET claim_token=NULL")) {
    if (owns) Object.assign(row, { claim_token: null, ...(params[2] !== undefined ? { last_error: params[2], failure_stage: "shopify_refund" } : {}), updated_at: new Date() });
    return [];
  }
  if (sql.startsWith("UPDATE refund_mappings SET status=CASE")) {
    if (!owns) return [];
    Object.assign(row, { status: row.status === "processing" ? "failed" : row.status, claim_token: null, last_error: params[2], updated_at: new Date() });
    return [];
  }
  if (sql.startsWith("SELECT 1 FROM refund_mappings")) return [{}];
  if (sql.startsWith("SELECT value FROM system_settings")) return m.cursor ? [{ value: { lastModifiedFrom: m.cursor } }] : [];
  throw new Error(`Unhandled SQL: ${sql.slice(0, 70)}`);
}
function stuckRows() {
  return [...m.rows.values()].filter((row) => !row.financial_refund_id && row.attempt_count < 10 &&
    ((row.status === "processing" && row.claimed_at && Date.now() - row.claimed_at.getTime() > 15 * 60_000) ||
     (row.status === "sending" && row.claim_token === null && Date.now() - row.updated_at.getTime() > 2 * 60_000) ||
     (row.status === "sending" && row.claim_token !== null && row.claimed_at && Date.now() - row.claimed_at.getTime() > 15 * 60_000)))
    .map((row) => ({ kiotviet_return_id: String(row.kiotviet_return_id), attempt_count: row.attempt_count }));
}

vi.mock("@/lib/db/client", () => {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    query: async (sql: string, params?: unknown[]) => run(sql, params),
    // Serialized like the advisory lock; yields so concurrent callers interleave.
    transaction: (callback: (client: unknown) => Promise<unknown>) => {
      const result = chain.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return callback({ query: async (sql: string, params?: unknown[]) => ({ rows: run(sql, params) }) });
      });
      chain = result.catch(() => undefined);
      return result;
    },
  };
});
vi.mock("@/lib/logger", () => ({ log: m.log }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: m.enqueue }));
vi.mock("@/lib/kiotviet/returns", () => ({
  getKiotVietReturn: async (id: number) => structuredClone(m.returns.get(id)),
  getKiotVietInvoice: async (id: number) => ({ id, code: `HD${id}`, orderCode: "DH501", status: 1, statusValue: "Hoàn thành" }),
  getKiotVietReturns: async () => ({ total: m.page.length, pageSize: 100, data: m.page }),
}));
vi.mock("@/lib/shopify/orders", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shopify/orders")>("@/lib/shopify/orders");
  return {
    ...actual,
    getShopifyRefundableLines: async () => ({ id: "gid://shopify/Order/7001", lineItems: { nodes: structuredClone(m.lines) }, refunds: structuredClone(m.refunds) }),
    getShopifyRefundTransactions: async (_orderId: string, amount: number) => {
      if (Math.round(amount * 100) > Math.round(m.available * 100))
        throw new actual.InsufficientRefundableAmountError(`Shopify has only ${m.available.toFixed(2)} available to refund, but KiotViet requested ${amount.toFixed(2)}`);
      return [{ orderId: "gid://shopify/Order/7001", parentId: "gid://shopify/OrderTransaction/1", gateway: "shopify_payments", kind: "REFUND", amount: amount.toFixed(2) }];
    },
    createShopifyReturnRefund: m.create,
  };
});

import {
  classifyExistingRefunds,
  matchReturnLines,
  reconcileKiotVietReturns,
  returnIdempotencyKey,
  syncKiotVietReturn,
} from "@/lib/sync/return-sync";
import { kiotVietReturnRefundNote, ShopifyRefundRejectedError } from "@/lib/shopify/orders";
import { RetryableError, UncertainResultError } from "@/lib/errors";

const kvReturn = (id: number, details: Array<[string, number]>, totalPayment: number | undefined = 50): KiotVietReturn => ({
  id, code: `TH${id}`, invoiceId: 9000, returnDate: "2026-11-05T01:00:00Z", returnTotal: 50, totalPayment: totalPayment as number,
  status: 1, statusValue: "Hoàn thành",
  returnDetails: details.map(([sku, quantity]) => ({ productId: 1, productCode: sku, productName: sku, quantity, price: 25 })),
});
/** Shopify creates the refund (and lists it on the order) exactly like the real mutation. */
function shopifyCreatesRefunds() {
  let next = 1;
  m.create.mockImplementation(async (_order: string, lines: Array<{ lineItemId: string; quantity: number }>, transactions: Array<{ amount: string }>, code: string) => {
    const refund: Refund = { id: `gid://shopify/Refund/${next++}`, note: kiotVietReturnRefundNote(code), createdAt: new Date().toISOString(),
      totalRefundedSet: { shopMoney: { amount: transactions.reduce((sum, t) => sum + Number(t.amount), 0).toFixed(2) } },
      refundLineItems: { nodes: lines.map((line) => ({ quantity: line.quantity, lineItem: { id: line.lineItemId, sku: m.lines.find((l) => l.id === line.lineItemId)?.sku } })) } };
    m.refunds.push(refund);
    for (const line of lines) m.lines.find((l) => l.id === line.lineItemId)!.refundableQuantity -= line.quantity;
    m.available -= transactions.reduce((sum, t) => sum + Number(t.amount), 0);
    return { id: refund.id };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows.clear();
  m.returns.clear();
  m.refunds = [];
  m.lines = [{ id: "gid://shopify/LineItem/1", sku: "SKU-1", refundableQuantity: 2 }, { id: "gid://shopify/LineItem/2", sku: "SKU-2", refundableQuantity: 1 }];
  m.available = 1000;
  m.failWrite = undefined;
  m.sql = [];
  m.cursor = undefined;
  m.page = [];
  m.returns.set(11, kvReturn(11, [["SKU-1", 2]]));
  shopifyCreatesRefunds();
  m.enqueue.mockResolvedValue({ id: "job" });
});

describe("return line mapping", () => {
  it("maps a KiotViet SKU to its refundable Shopify line", () => {
    expect(matchReturnLines([{ productId: 1, productCode: " sku-1 ", productName: "P", quantity: 1, price: 100 }], [{ id: "line-1", sku: "SKU-1", refundableQuantity: 2 }]))
      .toEqual([{ lineItemId: "line-1", quantity: 1 }]);
  });
  it("rejects a quantity exceeding the refundable quantity", () => {
    expect(() => matchReturnLines([{ productId: 1, productCode: "SKU-1", productName: "P", quantity: 2, price: 100 }], [{ id: "line-1", sku: "SKU-1", refundableQuantity: 1 }])).toThrow(/exceeds/);
  });
  it("aggregates a repeated SKU and spreads it over repeated Shopify lines deterministically", () => {
    const returned = [{ productId: 1, productCode: "SKU-1", productName: "P", quantity: 1, price: 10 }, { productId: 1, productCode: "sku-1", productName: "P", quantity: 2, price: 10 }];
    expect(matchReturnLines(returned, [{ id: "b", sku: "SKU-1", refundableQuantity: 5 }, { id: "a", sku: "SKU-1", refundableQuantity: 2 }]))
      .toEqual([{ lineItemId: "a", quantity: 2 }, { lineItemId: "b", quantity: 1 }]);
  });
});

describe("existing Shopify refunds are evidence only when they carry this return's note", () => {
  const returned = kvReturn(11, [["SKU-1", 1]]);
  const sameSku: Refund = { id: "r-manual", createdAt: "2026-11-04T00:00:00Z", refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: "1", sku: "sku-1" } }] } };
  it("a refund with the same SKU and quantity is suspicious, not proof of payment", () => {
    expect(classifyExistingRefunds(returned, [sameSku], new Set())).toMatchObject({ ours: [], suspicious: [{ id: "r-manual" }] });
  });
  it("a refund already linked to another return is ignored", () => {
    expect(classifyExistingRefunds(returned, [sameSku], new Set(["r-manual"]))).toMatchObject({ ours: [], suspicious: [] });
  });
  it("this app's own refund for the return is recognized by its note", () => {
    const ours = { ...sameSku, id: "r-ours", note: kiotVietReturnRefundNote("TH11") };
    expect(classifyExistingRefunds(returned, [ours], new Set())).toMatchObject({ ours: [{ id: "r-ours" }], suspicious: [] });
  });
});

describe("KiotViet return → Shopify financial refund", () => {
  it("creates exactly one refund, persisting the request and the deterministic key before sending", async () => {
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ created: true, refundId: "gid://shopify/Refund/1", amount: 50 });
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.create.mock.calls[0][4]).toBe(returnIdempotencyKey(11));
    expect(m.rows.get(11)).toMatchObject({ status: "financial_refunded", financial_refund_id: "gid://shopify/Refund/1", source: "created",
      idempotency_key: returnIdempotencyKey(11), request: expect.objectContaining({ amount: 50, lines: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }] }) });
    const order = m.sql.map((sql) => (sql.startsWith("UPDATE refund_mappings SET status='sending'") ? "sending" : sql.startsWith("UPDATE refund_mappings SET status=$3") ? "result" : "")).filter(Boolean);
    expect(order).toEqual(["sending", "result"]);
  });

  it("never sends a money-only refund when a matching refund already exists (the original defect)", async () => {
    m.refunds = [{ id: "gid://shopify/Refund/manual", createdAt: "2026-11-05T02:00:00Z", totalRefundedSet: { shopMoney: { amount: "50.00" } },
      refundLineItems: { nodes: [{ quantity: 2, lineItem: { id: "gid://shopify/LineItem/1", sku: "SKU-1" } }] } }];
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "needs_review" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.rows.get(11)).toMatchObject({ status: "needs_review", financial_refund_id: null, last_error: expect.stringContaining("existing_refund_unverified") });
  });

  it("a staff money-only refund made after the return also needs review", async () => {
    m.refunds = [{ id: "gid://shopify/Refund/money", createdAt: "2026-11-05T03:00:00Z", totalRefundedSet: { shopMoney: { amount: "50.00" } }, refundLineItems: { nodes: [] } }];
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "needs_review" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("duplicate return jobs (sequential and concurrent) create one refund", async () => {
    await syncKiotVietReturn(11);
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ created: false, reason: "already_financially_refunded" });
    m.rows.clear(); m.refunds = []; m.create.mockClear(); m.lines[0].refundableQuantity = 2;
    const results = await Promise.allSettled([syncKiotVietReturn(11), syncKiotVietReturn(11), syncKiotVietReturn(11)]);
    expect(m.create).toHaveBeenCalledOnce();
    expect(results.filter((result) => result.status === "fulfilled" && (result.value as { created: boolean }).created)).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").every((result) => (result as PromiseRejectedResult).reason instanceof RetryableError)).toBe(true);
  });

  it("partial returns of the same SKU: the second return refunds only its own units and ignores the first refund", async () => {
    m.returns.set(11, kvReturn(11, [["SKU-1", 1]], 25));
    m.returns.set(12, kvReturn(12, [["SKU-1", 1]], 25));
    await syncKiotVietReturn(11);
    await expect(syncKiotVietReturn(12)).resolves.toMatchObject({ created: true, amount: 25 });
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(m.rows.get(12)!.request).toMatchObject({ lines: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }] });
  });

  it("API timeout after Shopify created the refund: stays 'sending', never resent, then linked", async () => {
    m.create.mockImplementationOnce(async (...args: unknown[]) => {
      shopifyCreatesRefunds();
      await (m.create.getMockImplementation() as (...a: unknown[]) => Promise<unknown>)(...args); // the refund exists at Shopify
      throw new UncertainResultError("Shopify mutation network failure or timeout; it may have been applied");
    });
    await expect(syncKiotVietReturn(11)).rejects.toBeInstanceOf(RetryableError);
    expect(m.rows.get(11)).toMatchObject({ status: "sending", claim_token: null, last_error: expect.stringContaining("outcome_unknown") });
    m.create.mockClear();
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ created: false, reason: "linked_existing_refund", refundId: "gid://shopify/Refund/1" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.rows.get(11)).toMatchObject({ status: "financial_refunded", financial_refund_id: "gid://shopify/Refund/1", source: "recovered" });
  });

  it("worker crash / database failure after Shopify success: the next run links the refund", async () => {
    m.failWrite = "UPDATE refund_mappings SET status=$3";
    await expect(syncKiotVietReturn(11)).rejects.toThrow("database failure");
    expect(m.rows.get(11)).toMatchObject({ status: "sending" });
    expect(m.refunds).toHaveLength(1);
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ reason: "linked_existing_refund" });
    expect(m.create).toHaveBeenCalledOnce();
  });

  it("database failure while marking 'sending': nothing is sent", async () => {
    m.failWrite = "UPDATE refund_mappings SET status='sending'";
    await expect(syncKiotVietReturn(11)).rejects.toThrow("database failure");
    expect(m.create).not.toHaveBeenCalled();
    expect(m.rows.get(11)).toMatchObject({ status: "failed" });
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ created: true });
    expect(m.create).toHaveBeenCalledOnce();
  });

  it("an unknown outcome with no refund visible: retried inside the window, needs_review after it, never resent", async () => {
    m.create.mockRejectedValueOnce(new UncertainResultError("timeout"));
    await expect(syncKiotVietReturn(11)).rejects.toBeInstanceOf(RetryableError);
    await expect(syncKiotVietReturn(11)).rejects.toThrow("not visible yet"); // still inside the 10-minute window
    m.rows.get(11)!.sent_at = new Date(Date.now() - 11 * 60_000);
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "needs_review" });
    expect(m.rows.get(11)).toMatchObject({ status: "needs_review", last_error: expect.stringContaining("refund_outcome_unknown") });
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "needs_review" });
    expect(m.create).toHaveBeenCalledOnce();
  });

  it("an explicit Shopify rejection is recorded as failed (definitely not refunded)", async () => {
    m.create.mockRejectedValueOnce(new ShopifyRefundRejectedError("Refund amount exceeds the refundable amount"));
    await expect(syncKiotVietReturn(11)).rejects.toBeInstanceOf(ShopifyRefundRejectedError);
    expect(m.rows.get(11)).toMatchObject({ status: "failed", financial_refund_id: null, last_error: expect.stringContaining("shopify_rejected") });
  });

  it("two refunds carrying this return's note (a past duplicate) are flagged, not repeated", async () => {
    const note = kiotVietReturnRefundNote("TH11");
    m.refunds = ["a", "b"].map((id) => ({ id, note, totalRefundedSet: { shopMoney: { amount: "50.00" } }, refundLineItems: { nodes: [] } }));
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "needs_review" });
    expect(m.rows.get(11)!.last_error).toContain("duplicate_refunds");
    expect(m.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no money paid back in KiotViet", () => m.returns.set(11, kvReturn(11, [["SKU-1", 2]], 0)), "no_payment_returned"],
    ["less payment available in Shopify than requested", () => { m.available = 49.99; }, "insufficient_refundable_payment"],
  ])("never refunds automatically when %s", async (_label, arrange, code) => {
    arrange();
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "needs_review" });
    expect(m.rows.get(11)!.last_error).toContain(code);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("a fresh claim by another worker blocks; a stale 'processing' claim (nothing sent) is reclaimed", async () => {
    m.rows.set(11, { kiotviet_return_id: 11, kiotviet_return_code: "TH11", shopify_order_id: "7001", status: "processing", claim_token: "other",
      claimed_at: new Date(), sent_at: null, financial_refund_id: null, shopify_refund_id: null, amount: null, attempt_count: 1, idempotency_key: returnIdempotencyKey(11),
      request: null, response: null, source: null, last_error: null, failure_stage: null, updated_at: new Date() });
    await expect(syncKiotVietReturn(11)).rejects.toBeInstanceOf(RetryableError);
    m.rows.get(11)!.claimed_at = new Date(Date.now() - 16 * 60_000);
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ created: true });
    expect(m.create).toHaveBeenCalledOnce();
  });

  it("an incomplete return creates no record", async () => {
    m.returns.set(11, { ...kvReturn(11, [["SKU-1", 1]]), status: 2, statusValue: "Phiếu tạm" });
    await expect(syncKiotVietReturn(11)).resolves.toEqual({ created: false, reason: "return_not_completed" });
    expect(m.rows.size).toBe(0);
  });
});

describe("scheduler", () => {
  it("re-queues an unknown 'sending' outcome for reconciliation with a per-attempt job id", async () => {
    m.create.mockRejectedValueOnce(new UncertainResultError("timeout"));
    await syncKiotVietReturn(11).catch(() => undefined);
    m.rows.get(11)!.updated_at = new Date(Date.now() - 3 * 60_000);
    await reconcileKiotVietReturns();
    expect(m.enqueue).toHaveBeenCalledWith("sync", "kiotviet_return_to_shopify", { returnId: 11 }, "high", "kiotviet-return-11-a1");
  });
});

describe("in-flight refund requests", () => {
  it("a second worker never takes over a claim whose refundCreate is still in flight", async () => {
    let release!: () => void;
    m.create.mockImplementationOnce(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      shopifyCreatesRefunds();
      return (m.create.getMockImplementation() as (...a: unknown[]) => Promise<unknown>)(...args);
    });
    const first = syncKiotVietReturn(11);
    await vi.waitFor(() => expect(m.rows.get(11)?.status).toBe("sending"));
    await expect(syncKiotVietReturn(11)).rejects.toThrow("being processed by another worker");
    release();
    await expect(first).resolves.toMatchObject({ created: true });
    expect(m.rows.get(11)).toMatchObject({ status: "financial_refunded", source: "created" });
    expect(m.create).toHaveBeenCalledOnce();
  });
});

describe("worker crash with refundCreate in flight", () => {
  it("is reconciled after the claim lease and linked, never resent", async () => {
    // Simulate the crash: the refund was created at Shopify, the worker died before any write.
    m.create.mockImplementationOnce(async (...args: unknown[]) => {
      shopifyCreatesRefunds();
      await (m.create.getMockImplementation() as (...a: unknown[]) => Promise<unknown>)(...args);
      return new Promise(() => undefined); // never returns
    });
    void syncKiotVietReturn(11);
    await vi.waitFor(() => expect(m.refunds).toHaveLength(1));
    expect(m.rows.get(11)).toMatchObject({ status: "sending" });
    expect(m.rows.get(11)!.claim_token).not.toBeNull();
    await expect(syncKiotVietReturn(11)).rejects.toThrow("being processed by another worker"); // lease still live
    m.rows.get(11)!.claimed_at = new Date(Date.now() - 16 * 60_000);
    await reconcileKiotVietReturns();
    expect(m.enqueue).toHaveBeenCalledWith("sync", "kiotviet_return_to_shopify", { returnId: 11 }, "high", "kiotviet-return-11-a1");
    await expect(syncKiotVietReturn(11)).resolves.toMatchObject({ reason: "linked_existing_refund" });
    expect(m.create).toHaveBeenCalledOnce();
  });
});
