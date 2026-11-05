import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyOrderWebhook } from "@/types/shopify";

interface Mapping {
  shopify_order_id: string; shopify_order_number: string | null; kiotviet_order_id: string | null;
  status: string | null; sync_status: string | null; failure_stage: string | null;
  claimed_at: string | null; updated_at: string;
}
const mocks = vi.hoisted(() => ({
  mapping: undefined as Mapping | undefined,
  event: undefined as { id: string; payload: unknown } | undefined,
  owners: new Map<number, string>(),
  activeJobs: [] as Array<{ id: string; status: string }>,
  orderSettings: {} as Record<string, unknown>,
  sql: [] as string[],
  transactions: 0,
  enqueue: vi.fn(),
  findOrder: vi.fn(),
  kiotVietGet: vi.fn(),
  syncEnabled: true,
  /** Shopify's current order; undefined = same as the stored webhook. */
  current: undefined as ShopifyOrderWebhook | undefined,
  fresh: vi.fn(),
}));

function read(sql: string, params: unknown[]) {
  mocks.sql.push(sql);
  if (sql.includes("FROM order_mappings WHERE shopify_order_id=$1")) return mocks.mapping ? [{ ...mocks.mapping }] : [];
  if (sql.includes("FROM webhook_events")) return mocks.event ? [mocks.event] : [];
  if (sql.includes("FROM system_settings")) return [{ value: mocks.orderSettings }];
  if (sql.includes("FROM order_mappings WHERE kiotviet_order_id=$1")) {
    const owner = mocks.owners.get(Number(params[0]));
    return owner ? [{ shopify_order_id: owner }] : [];
  }
  if (sql.includes("FROM sync_jobs")) return mocks.activeJobs;
  throw new Error(`Unhandled read: ${sql.slice(0, 60)}`);
}
function write(sql: string, params: unknown[]) {
  mocks.sql.push(sql);
  const m = mocks.mapping;
  if (sql.includes("pg_advisory_xact_lock")) return [];
  if (sql.startsWith("SELECT")) return read(sql, params);
  if (sql.startsWith("INSERT INTO order_mappings(shopify_order_id,kiotviet_order_id")) {
    if (m?.kiotviet_order_id) return [];
    mocks.mapping = { ...(m ?? { shopify_order_number: null, claimed_at: null }), shopify_order_id: String(params[0]), kiotviet_order_id: String(params[1]), status: "created", sync_status: "synced", failure_stage: "manual_recovery", updated_at: new Date().toISOString() } as Mapping;
    mocks.owners.set(Number(params[1]), String(params[0]));
    return [{ shopify_order_id: params[0] }];
  }
  if (sql.startsWith("UPDATE order_mappings SET status='create_failed'")) {
    if (!m || m.kiotviet_order_id || m.status !== params[1] || m.updated_at !== params[2]) return [];
    Object.assign(m, { status: "create_failed", sync_status: "failed", failure_stage: "manual_recovery", updated_at: new Date(Date.now() + 1).toISOString() });
    return [{ shopify_order_id: params[0] }];
  }
  if (sql.startsWith("INSERT INTO order_mappings(shopify_order_id,status")) {
    if (m) return [];
    mocks.mapping = { shopify_order_id: String(params[0]), shopify_order_number: null, kiotviet_order_id: null, status: "create_failed", sync_status: "failed", failure_stage: "manual_recovery", claimed_at: null, updated_at: new Date().toISOString() };
    return [{ shopify_order_id: params[0] }];
  }
  throw new Error(`Unhandled write: ${sql.slice(0, 60)}`);
}

vi.mock("@/lib/db/client", () => {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    query: async (sql: string, params: unknown[] = []) => read(sql, params),
    transaction: (callback: (client: unknown) => Promise<unknown>) => {
      mocks.transactions++;
      const result = chain.then(async () => {
        // Yield inside the transaction so concurrent callers really interleave.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return callback({ query: async (sql: string, params: unknown[] = []) => { const rows = write(sql, params); return { rows, rowCount: rows.length }; } });
      });
      chain = result.catch(() => undefined);
      return result;
    },
  };
});
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/kiotviet/orders", () => ({ findKiotVietOrderByShopifyReference: mocks.findOrder }));
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietClient: { get: mocks.kiotVietGet } }));
vi.mock("@/lib/sync/sync-settings", () => ({ getSyncSettings: async () => ({ shopifyOrdersToKiotViet: mocks.syncEnabled }) }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/shopify/invoice-order", () => ({ getInvoiceOrder: mocks.fresh }));

import {
  applyOrderRecovery,
  describeRecoveryPlan,
  parseRecoveryArgs,
  planOrderRecovery,
  RecoveryArgsError,
} from "@/lib/recovery/shopify-order-recovery";

const ORDER_ID = "7128306221240";
const order1081: ShopifyOrderWebhook = {
  id: 7128306221240, name: "#1081", financial_status: "paid", total_price: "309000.00",
  line_items: [
    { id: 11, sku: "NU012", quantity: 2, price: "150000.00", title: "Áo thun", name: "Áo thun" },
    { id: 15977877143736, sku: null, quantity: 1, price: "9000.00", title: "SVC Fee - Credit Card Processing Fee", name: "SVC Fee - Credit Card Processing Fee" },
  ],
};
const stuck = (overrides: Partial<Mapping> = {}): Mapping => ({
  shopify_order_id: ORDER_ID, shopify_order_number: "#1081", kiotviet_order_id: null,
  status: "creating", sync_status: "pending", failure_stage: null,
  claimed_at: null, updated_at: "2026-10-29T03:00:00.123Z", ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mapping = stuck();
  mocks.event = { id: "event-1081", payload: order1081 };
  mocks.owners.clear();
  mocks.activeJobs = [];
  mocks.orderSettings = {};
  mocks.sql = [];
  mocks.transactions = 0;
  mocks.syncEnabled = true;
  mocks.current = undefined;
  mocks.fresh.mockImplementation(async () => structuredClone(mocks.current ?? (mocks.event?.payload as ShopifyOrderWebhook)));
  mocks.findOrder.mockResolvedValue(undefined);
  mocks.enqueue.mockImplementation(async (_queue, _type, _payload, _priority, jobId) => ({ id: jobId }));
});

describe("recovery CLI arguments", () => {
  it("accepts a single Shopify order ID (the reported bug)", () => {
    expect(parseRecoveryArgs([ORDER_ID])).toEqual({ mode: "recover", shopifyOrderIds: [ORDER_ID], apply: false, linkKiotVietOrderId: undefined });
  });
  it("accepts multiple IDs, deduplicates them and keeps their order", () => {
    expect(parseRecoveryArgs(["2", ORDER_ID, "2", "--apply"])).toMatchObject({ shopifyOrderIds: ["2", ORDER_ID], apply: true });
  });
  it("accepts Shopify order GIDs", () => {
    expect(parseRecoveryArgs([`gid://shopify/Order/${ORDER_ID}`])).toMatchObject({ shopifyOrderIds: [ORDER_ID] });
  });
  it.each([
    [[`${ORDER_ID}`, "--link-kiotviet-order", "24102572"], ORDER_ID],
    [[`--link-kiotviet-order=24102572`, `${ORDER_ID}`, "--apply"], ORDER_ID],
  ])("keeps the KiotViet ID separate from the Shopify ID (%j)", (argv, shopifyId) => {
    const args = parseRecoveryArgs(argv);
    expect(args).toMatchObject({ mode: "recover", shopifyOrderIds: [shopifyId], linkKiotVietOrderId: "24102572" });
  });
  it("parses --list", () => expect(parseRecoveryArgs(["--list"])).toEqual({ mode: "list" }));
  it.each([
    [[], "at least one Shopify order ID"],
    [["--apply"], "at least one Shopify order ID"],
    [["#1081"], "Invalid Shopify order ID"],
    [["abc"], "Invalid Shopify order ID"],
    [["0"], "Invalid Shopify order ID"],
    [["-5"], "Unknown option"],
    [["--force", ORDER_ID], "Unknown option"],
    [[ORDER_ID, "--link-kiotviet-order"], "requires a KiotViet order ID"],
    [[ORDER_ID, "--link-kiotviet-order", "--apply"], "requires a KiotViet order ID"],
    [[ORDER_ID, "--link-kiotviet-order", "DH001"], "Invalid KiotViet order ID"],
    [[ORDER_ID, "2", "--link-kiotviet-order", "3"], "exactly one Shopify order ID"],
    [[ORDER_ID, "--link-kiotviet-order", ORDER_ID], "equals the Shopify order ID"],
    [[ORDER_ID, "--link-kiotviet-order", "1", "--link-kiotviet-order", "2"], "only once"],
    [["--list", ORDER_ID], "cannot be combined"],
    [["--list", "--apply"], "cannot be combined"],
  ])("rejects %j with a clear error", (argv, message) => {
    expect(() => parseRecoveryArgs(argv)).toThrow(RecoveryArgsError);
    expect(() => parseRecoveryArgs(argv)).toThrow(message);
  });
});

describe("recovery plan (dry run)", () => {
  it("plans a single requeue for #1081 stuck in creating, showing the skipped fee", async () => {
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toEqual({ kind: "requeue", eventId: "event-1081", resetFrom: "creating" });
    const output = describeRecoveryPlan(plan).join("\n");
    expect(output).toContain('skipped processing fee: line 15977877143736 "SVC Fee - Credit Card Processing Fee" sku=null amount=9000 (exact_title_without_sku)');
    expect(output).toContain("shopify_total=309000 excluded_fees=9000");
    expect(output).toContain("planned KiotViet totalPayment: 300000");
    expect(output).toContain("current Shopify state: financial_status=paid cancelled=false payment_eligible=true");
    expect(output).toContain("lines to send: NU012×2");
    expect(output).toContain("PLAN: reset creating → create_failed, then enqueue one shopify_order_update job");
  });

  it("is read-only: no writes, no transactions, no jobs", async () => {
    await planOrderRecovery(ORDER_ID);
    expect(mocks.sql.every((sql) => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(mocks.transactions).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("checks KiotViet first and relinks an existing order instead of recreating it", async () => {
    mocks.findOrder.mockResolvedValue({ id: 900, code: "DH900" });
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toEqual({ kind: "link", source: "existing_reference", kiotVietOrder: { id: 900, code: "DH900" } });
    await expect(applyOrderRecovery(plan)).resolves.toMatchObject({ applied: true });
    expect(mocks.mapping).toMatchObject({ kiotviet_order_id: "900", status: "created" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to relink a KiotViet order already linked to another Shopify order", async () => {
    mocks.findOrder.mockResolvedValue({ id: 900, code: "DH900" });
    mocks.owners.set(900, "999");
    expect((await planOrderRecovery(ORDER_ID)).action.kind).toBe("blocked");
  });

  it("does nothing for an order that is already linked", async () => {
    mocks.mapping = stuck({ kiotviet_order_id: "900", status: "created" });
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "none" });
    expect(mocks.findOrder).not.toHaveBeenCalled();
  });

  it("requires manual creation when a real product has no SKU", async () => {
    mocks.event = { id: "e", payload: { ...order1081, line_items: [...order1081.line_items, { id: 77, sku: null, quantity: 1, price: "1", title: "Custom" }] } };
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action.kind).toBe("manual_create_required");
    expect(describeRecoveryPlan(plan).join("\n")).toContain("--link-kiotviet-order");
  });

  it("does nothing for a fee-only order", async () => {
    mocks.event = { id: "e", payload: { ...order1081, total_price: "9000", line_items: [order1081.line_items[1]] } };
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "none", reason: expect.stringContaining("processing-fee") });
  });

  it("blocks while another job for the order may still retry", async () => {
    mocks.activeJobs = [{ id: "job-7", status: "failed" }];
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reason: expect.stringContaining("job-7") });
  });

  it("blocks a creating row whose create request may still be in flight", async () => {
    mocks.mapping = stuck({ claimed_at: new Date().toISOString() });
    expect((await planOrderRecovery(ORDER_ID)).action.kind).toBe("blocked");
  });

  it("blocks when Shopify → KiotViet order sync is disabled", async () => {
    mocks.syncEnabled = false;
    expect((await planOrderRecovery(ORDER_ID)).action.kind).toBe("blocked");
  });
});

describe("manual KiotViet order linking", () => {
  const kiotVietOrder = (description: string, extra: Record<string, unknown> = {}) =>
    mocks.kiotVietGet.mockResolvedValue({ id: 24102572, code: "DH24102572", description, status: 1, ...extra });

  it("links a KiotViet order whose description references the Shopify order", async () => {
    kiotVietOrder(`Shopify #1081 (${ORDER_ID})`);
    const plan = await planOrderRecovery(ORDER_ID, { linkKiotVietOrderId: "24102572" });
    expect(plan.action).toMatchObject({ kind: "link", source: "manual" });
    await applyOrderRecovery(plan);
    expect(mocks.mapping?.kiotviet_order_id).toBe("24102572");
  });

  it.each([
    ["no reference in the description", () => kiotVietOrder("Walk-in order"), "does not mention"],
    ["a different ID that only contains this one", () => kiotVietOrder(`Shopify (${ORDER_ID}9)`), "does not mention"],
    ["a cancelled KiotViet order", () => kiotVietOrder(`(${ORDER_ID})`, { status: 4 }), "cancelled"],
    ["an order owned by another Shopify order", () => { kiotVietOrder(`(${ORDER_ID})`); mocks.owners.set(24102572, "42"); }, "already linked"],
    ["a different order already referencing it", () => { kiotVietOrder(`(${ORDER_ID})`); mocks.findOrder.mockResolvedValue({ id: 1, code: "DH1" }); }, "already references"],
  ])("refuses %s", async (_label, setup, reason) => {
    setup();
    const plan = await planOrderRecovery(ORDER_ID, { linkKiotVietOrderId: "24102572" });
    expect(plan.action).toMatchObject({ kind: "blocked", reason: expect.stringContaining(reason) });
    await expect(applyOrderRecovery(plan)).resolves.toMatchObject({ applied: false });
    expect(mocks.mapping?.kiotviet_order_id).toBeNull();
  });
});

describe("applying recovery", () => {
  it("resets the stuck mapping and enqueues exactly one job", async () => {
    const result = await applyOrderRecovery(await planOrderRecovery(ORDER_ID));
    expect(result.applied).toBe(true);
    expect(mocks.mapping).toMatchObject({ status: "create_failed", failure_stage: "manual_recovery" });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith("webhooks", "shopify_order_update", { eventId: "event-1081", recovery: true }, "normal",
      `recovery-shopify-order-${ORDER_ID}-event-1081-${Date.parse("2026-10-29T03:00:00.123Z")}`);
  });

  it("recovers an order at most once when two operators apply the same dry-run concurrently", async () => {
    const [first, second] = await Promise.all([planOrderRecovery(ORDER_ID), planOrderRecovery(ORDER_ID)]);
    const results = await Promise.all([applyOrderRecovery(first), applyOrderRecovery(second)]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("does not re-apply a stale plan after the mapping changed", async () => {
    const plan = await planOrderRecovery(ORDER_ID);
    mocks.mapping!.updated_at = "2026-11-04T00:00:00.000Z";
    await expect(applyOrderRecovery(plan)).resolves.toMatchObject({ applied: false });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * #1081 (7128306221240) with an outdated stored webhook. Illustrative refund data (the
 * reported case gives only the order): the stored orders/updated says "paid" with 2 × NU012,
 * while Shopify now has a refund of 1 unit, so the order is PARTIALLY_REFUNDED.
 */
describe("#1081: recovery uses Shopify's current state, not the stored webhook", () => {
  const productOnly = { invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "VND", productOnlyInvoicing: true };
  const refundedNow = (restockType: string, extra: Partial<ShopifyOrderWebhook> = {}): ShopifyOrderWebhook => ({
    ...structuredClone(order1081), financial_status: "partially_refunded", updated_at: "2026-11-05T02:00:00Z",
    line_items: order1081.line_items.map((line) => (line.id === 11 ? { ...line, current_quantity: 1 } : line)),
    refunds: [{ id: 501, refund_line_items: [{ line_item_id: 11, quantity: 1, restock_type: restockType, subtotal: "150000.00" }],
      transactions: [{ kind: "refund", status: "success", amount: "150000.00" }] }],
    fulfillments: [], ...extra,
  });
  beforeEach(() => { mocks.orderSettings = productOnly; });

  it("treats PARTIALLY_REFUNDED as paid in Product-Only and plans the remaining quantity and exact payment", async () => {
    mocks.current = refundedNow("cancel");
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toEqual({ kind: "requeue", eventId: "event-1081", resetFrom: "creating" });
    expect(plan.current).toMatchObject({ financialStatus: "partially_refunded", storedFinancialStatus: "paid", paymentEligible: true, plannedPayment: 150000 });
    expect(plan.prepared!.lines.map(({ sku, quantity }) => [sku, quantity])).toEqual([["NU012", 1]]);
    const output = describeRecoveryPlan(plan).join("\n");
    expect(output).toContain("current Shopify state: financial_status=partially_refunded cancelled=false payment_eligible=true (stored webhook says paid: outdated, not used)");
    expect(output).toContain("refunded line 11 SKU NU012: ordered=2 refunded=1 excluded=1 remaining=1 fulfilled=0 (cancelled_refund");
    expect(output).toContain("lines to send: NU012×1");
    expect(output).toContain("planned KiotViet totalPayment: 150000");
  });

  it("never plans from the stored webhook when Shopify cannot be read", async () => {
    mocks.fresh.mockRejectedValue(new Error("Shopify GraphQL 503"));
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "blocked", reason: expect.stringContaining("cannot read the current Shopify order (Shopify GraphQL 503)") });
    expect(describeRecoveryPlan(plan).join("\n")).toContain("current Shopify state: UNAVAILABLE");
    await applyOrderRecovery(plan);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["return", "refunded as return/restock"],
    ["no_restock", "refunded units may have been shipped"],
  ])("requires manual review when the refunded unit may have been shipped (%s)", async (restockType, text) => {
    mocks.current = refundedNow(restockType, { fulfillments: [{ id: 1, status: "success", line_items: [{ id: 11, quantity: 2 }] }] });
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "manual_create_required", reason: expect.stringContaining("refund_requires_verification") });
    expect(describeRecoveryPlan(plan).join("\n")).toContain(`refund ambiguity (blocks creation): refund_requires_verification: line item 11 (SKU NU012)`);
    expect(describeRecoveryPlan(plan).join("\n")).toContain(text);
    await applyOrderRecovery(plan);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("strict invoicing still requires financial status paid", async () => {
    mocks.orderSettings = {};
    mocks.current = refundedNow("cancel");
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reason: expect.stringContaining("not_paid: Shopify financial status is partially_refunded") });
  });

  it("blocks a cancelled order and an order whose units were all cancelled", async () => {
    mocks.current = { ...refundedNow("cancel"), cancelled_at: "2026-11-05T03:00:00Z" };
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reason: "the Shopify order is cancelled" });
    mocks.current = refundedNow("cancel");
    mocks.current.line_items[0].current_quantity = 0;
    mocks.current.refunds![0].refund_line_items![0].quantity = 2;
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "none", reason: expect.stringContaining("every product unit was cancelled") });
  });

  it("repeated recovery attempts enqueue at most one job and never a second order", async () => {
    mocks.current = refundedNow("cancel");
    const plan = await planOrderRecovery(ORDER_ID);
    await expect(applyOrderRecovery(plan)).resolves.toMatchObject({ applied: true });
    // The same dry run applied again, and a new dry run while the job is pending, change nothing.
    await expect(applyOrderRecovery(plan)).resolves.toMatchObject({ applied: false });
    mocks.activeJobs = [{ id: "job-1", status: "pending" }];
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reason: expect.stringContaining("job job-1 (pending)") });
    // Once the worker created and linked the order, recovery does nothing.
    mocks.mapping = stuck({ kiotviet_order_id: "900", status: "created" });
    expect((await planOrderRecovery(ORDER_ID)).action).toMatchObject({ kind: "none" });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("reports (never applies) a later refund against an existing KiotViet order", async () => {
    mocks.mapping = stuck({ kiotviet_order_id: "900", status: "created" });
    mocks.current = refundedNow("cancel");
    mocks.kiotVietGet.mockResolvedValue({ id: 900, code: "DH900", orderDetails: [{ productCode: "NU012", quantity: 2 }] });
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "none", reason: expect.stringContaining("never changed automatically") });
    expect(plan.reconciliation).toEqual([{ sku: "NU012", kiotVietQuantity: 2, shopifyEffectiveQuantity: 1 }]);
    expect(describeRecoveryPlan(plan).join("\n")).toContain("RECONCILE (manual, never automatic): SKU NU012 is 2 on the KiotViet order but 1 in Shopify now");
    await applyOrderRecovery(plan);
    expect(mocks.sql.filter((sql) => !sql.trimStart().startsWith("SELECT"))).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("#1081 dry run under the merchant policy (refund means not shipped)", () => {
  // SKUs, quantities, E54 line item id and totals from #1081; unit prices illustrative.
  const skus: Array<[number, string, number, string]> = [
    [1, "860", 1, "39.00"], [2, "834", 1, "32.00"], [3, "460", 1, "26.00"], [4, "424", 2, "24.50"],
    [5, "1331", 2, "31.60"], [6, "E38", 1, "45.00"], [7, "1241", 1, "43.00"], [15977877045432, "E54", 1, "28.00"],
  ];
  const storedPaid: ShopifyOrderWebhook = { id: 7128306221240, name: "#1081", financial_status: "paid", currency: "USD", total_price: "335.20",
    line_items: skus.map(([id, sku, quantity, price]) => ({ id, sku, quantity, price, title: sku, name: sku })),
    shipping_lines: [{ price: "10.00", discounted_price: "10.00" }] };
  const now: ShopifyOrderWebhook = { ...structuredClone(storedPaid), financial_status: "partially_refunded",
    line_items: storedPaid.line_items.map((line) => ({ ...line, current_quantity: line.sku === "E54" ? 0 : line.quantity })),
    refunds: [{ id: 9001, refund_line_items: [{ id: 7001, line_item_id: 15977877045432, quantity: 1, restock_type: "no_restock", subtotal: "28.00" }],
      transactions: [{ kind: "refund", status: "success", amount: "28.00" }] }],
    fulfillments: [{ id: 1, status: "success", line_items: skus.map(([id, , quantity]) => ({ id, quantity })) }] };

  it("plans 9 units and a 297.20 payment from Shopify's current state, without manual approval", async () => {
    mocks.orderSettings = { invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD", productOnlyInvoicing: true, refundedItemsPolicy: "refund_means_not_shipped" };
    mocks.event = { id: "event-1081", payload: storedPaid };
    mocks.current = now;
    const plan = await planOrderRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "requeue" });
    expect(plan.current).toMatchObject({ financialStatus: "partially_refunded", paymentEligible: true, plannedPayment: 297.2 });
    const output = describeRecoveryPlan(plan).join("\n");
    expect(output).toContain("lines to send: 860×1, 834×1, 460×1, 424×2, 1331×2, E38×1, 1241×1");
    expect(output).toContain("refunded line 15977877045432 SKU E54: ordered=1 refunded=1 excluded=1 remaining=0 fulfilled=1 (refunded_not_shipped");
    expect(output).toContain("planned KiotViet totalPayment: 297.2");
    expect(output).not.toContain("refund ambiguity");
  });
});
