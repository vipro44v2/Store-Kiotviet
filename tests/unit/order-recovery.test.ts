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
    expect(output).toContain("shopify_total=309000 excluded_fees=9000 kiotviet_payment=300000");
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
