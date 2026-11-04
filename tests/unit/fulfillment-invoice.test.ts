import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), live: vi.fn(), add: vi.fn(), plan: vi.fn(), apply: vi.fn(), stock: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ query: m.query }));
vi.mock("@/lib/shopify/orders", () => ({ getShopifyOrderPaymentState: m.live }));
vi.mock("@/lib/queue/queues", () => ({ getQueue: () => ({ add: m.add }) }));
vi.mock("@/lib/redis/client", () => ({ isRedisEnabled: () => true }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ JOB_MAX_ATTEMPTS: 5 }) }));
vi.mock("@/lib/recovery/kiotviet-invoice-recovery", () => ({ planInvoiceRecovery: m.plan, applyInvoiceRecovery: m.apply }));
vi.mock("@/lib/sync/sync-settings", () => ({ getSyncSettings: async () => ({ kiotVietInventoryToShopify: true, inventoryConflictStrategy: "hold" }) }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: m.stock }));
import { invoiceTriggerDecision, requestFulfillmentInvoice, processFulfillmentInvoice, dispatchInvoiceOutbox, reconcileFulfillmentInvoices } from "@/lib/sync/fulfillment-invoice";

const config = { invoiceCreationTrigger: "shopify_fulfilled" as const, invoiceTriggerEnabledAt: "2026-11-01T00:00:00Z" };
const live = { createdAt: "2026-11-02T00:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED" };
let mapped: boolean, outbox: boolean, attached: boolean;
beforeEach(() => {
  vi.resetAllMocks(); mapped = true; outbox = false; attached = false;
  m.live.mockResolvedValue(live);
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM system_settings")) return [{ value: config }];
    if (sql.includes("SELECT 1 FROM order_mappings")) return mapped ? [{}] : [];
    if (sql.includes("INSERT INTO sync_jobs")) { outbox = true; return []; }
    if (sql.includes("SELECT id,payload FROM sync_jobs")) return outbox && !attached ? [{ id: "audit", payload: { entityId: "1" } }] : [];
    if (sql.includes("SET queue_job_id")) { attached = true; return []; }
    if (sql.includes("SELECT o.shopify_order_id")) return [{ shopify_order_id: "1" }];
    if (sql.includes("SELECT * FROM invoice_mappings")) return [{ kiotviet_invoice_id: "8", status: "created", reconciliation: {
      branchId: 10, expectedLines: [{ productId: 2, sku: "sku", quantity: 1, price: 80 }],
    } }];
    return [];
  });
  m.plan.mockResolvedValue({ action: { kind: "create_invoice" } });
  m.apply.mockResolvedValue({ applied: true });
  m.stock.mockResolvedValue({ status: "synced" });
});

it.each([
  ["UNFULFILLED", "waiting"], ["FULFILLED", "ready"], ["PARTIALLY_FULFILLED", "partial"],
])("uses current fulfillment %s", (status, expected) => {
  expect(invoiceTriggerDecision(config, { ...live, displayFulfillmentStatus: status })).toBe(expected);
});
it("preserves legacy behavior and excludes historical orders", () => {
  expect(invoiceTriggerDecision({ autoInvoice: true }, live)).toBe("disabled");
  expect(invoiceTriggerDecision(config, { ...live, createdAt: "2026-10-01" })).toBe("historical");
  expect(invoiceTriggerDecision({ ...config, invoiceCreationTrigger: "disabled" }, live)).toBe("disabled");
});
it("Paid option admits unfulfilled orders but never partial fulfillment", () => {
  const paid = { ...config, invoiceCreationTrigger: "shopify_paid" as const };
  expect(invoiceTriggerDecision(paid, { ...live, displayFulfillmentStatus: "UNFULFILLED" })).toBe("ready");
  expect(invoiceTriggerDecision(paid, { ...live, displayFulfillmentStatus: "PARTIALLY_FULFILLED" })).toBe("partial");
});
it.each([{ cancelledAt: "2026-11-03" }, { displayFinancialStatus: "REFUNDED" }])("blocks cancellation/refund %j", (change) => {
  expect(invoiceTriggerDecision(config, { ...live, ...change })).toBe("blocked");
});
it("paid but unfulfilled creates no invoice job", async () => {
  m.live.mockResolvedValue({ ...live, displayFulfillmentStatus: "UNFULFILLED" });
  await requestFulfillmentInvoice("1");
  expect(outbox).toBe(false);
});
it("fulfilled before order creation waits; completion then admits the invoice", async () => {
  mapped = false;
  await requestFulfillmentInvoice("1");
  expect(outbox).toBe(false);
  mapped = true;
  await requestFulfillmentInvoice("1");
  expect(m.add).toHaveBeenCalledOnce();
});
it("duplicate fulfillment events reuse one durable outbox record and queue job", async () => {
  await requestFulfillmentInvoice("1"); await requestFulfillmentInvoice("1");
  expect(m.add).toHaveBeenCalledOnce();
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), ["1", 5]);
});
it("repairs a failed Redis handoff without a new database job", async () => {
  m.add.mockRejectedValueOnce(new Error("Redis unavailable"));
  await expect(requestFulfillmentInvoice("1")).rejects.toThrow("Redis unavailable");
  expect(outbox).toBe(true); expect(attached).toBe(false);
  await dispatchInvoiceOutbox();
  expect(attached).toBe(true);
  expect(m.add.mock.calls.map(c => c[2].jobId)).toEqual(["invoice-audit", "invoice-audit"]);
});
it("reconciles a missed fulfillment webhook using bounded live checks", async () => {
  await reconcileFulfillmentInvoices();
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT 50"), [config.invoiceTriggerEnabledAt]);
  expect(m.add).toHaveBeenCalledOnce();
});
it("creates through the recovery claim and sends absolute refreshed stock", async () => {
  await processFulfillmentInvoice("1");
  expect(m.apply).toHaveBeenCalledOnce();
  expect(m.stock).toHaveBeenCalledWith(expect.objectContaining({ ProductId: 2, BranchId: 10 }), undefined,
    { refreshFromKiotViet: true, conflictStrategy: "hold" });
});
it("an existing invoice never invokes creation during stock retry", async () => {
  m.plan.mockResolvedValue({ action: { kind: "none" } });
  await processFulfillmentInvoice("1");
  expect(m.apply).not.toHaveBeenCalled(); expect(m.stock).toHaveBeenCalledOnce();
});
it("incomplete lookup needs review and cannot create", async () => {
  m.plan.mockResolvedValue({ action: { kind: "blocked", reasons: ["invoice_lookup_incomplete"] } });
  await expect(processFulfillmentInvoice("1")).rejects.toThrow("invoice_lookup_incomplete");
  expect(m.apply).not.toHaveBeenCalled();
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("needs_review"), ["1", "invoice_lookup_incomplete"]);
});
it("stock conflicts do not turn into a second invoice", async () => {
  m.plan.mockResolvedValue({ action: { kind: "none" } });
  m.stock.mockResolvedValue({ status: "held" });
  await expect(processFulfillmentInvoice("1")).rejects.toThrow("inventory synchronization requires review");
  expect(m.apply).not.toHaveBeenCalled();
});
