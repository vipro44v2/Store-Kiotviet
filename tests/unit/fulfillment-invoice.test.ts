import { beforeEach, describe, expect, it, vi } from "vitest";

interface Job { id: string; entityId: string; triggerState: string; status: string; attempts: number; max: number; queueJobId: string | null }
const m = vi.hoisted(() => ({
  live: vi.fn(), add: vi.fn(), plan: vi.fn(), apply: vi.fn(), stock: vi.fn(),
  config: {} as Record<string, unknown>,
  settingsVersion: "settings-v1",
  mapped: true,
  invoice: undefined as Record<string, unknown> | undefined,
  blocked: undefined as Record<string, unknown> | undefined,
  jobs: [] as Job[],
  checkAt: undefined as string | undefined,
  indexHealth: { usable: true, scanned: 100, total: 100, lastError: null } as Record<string, unknown>,
}));

function run(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const id = String(params[0] ?? "");
  if (sql.includes("FROM system_settings")) return [{ value: m.config, updated_at: m.settingsVersion }];
  if (sql.includes("AS invoice_id FROM order_mappings")) return m.mapped ? [{ invoice_id: m.invoice?.kiotviet_invoice_id ?? null }] : [];
  if (sql.startsWith("UPDATE order_mappings SET invoice_check_at")) {
    m.checkAt = sql.includes("infinity") ? "infinity" : sql.includes("30 minutes") ? "+30m" : "+5m";
    return [];
  }
  if (sql.startsWith("INSERT INTO invoice_mappings")) {
    const row = m.blocked;
    if (!row || (!row.kiotviet_invoice_id && ["blocked", "failed"].includes(String(row.status))))
      m.blocked = { ...(row ?? {}), status: "blocked", last_error: params[1], failure_stage: params[2] };
    return [];
  }
  if (sql.startsWith("INSERT INTO sync_jobs")) {
    const state = String(params[2]);
    const mine = m.jobs.filter((job) => job.entityId === id);
    if (mine.some((job) => ["pending", "processing"].includes(job.status) || (job.status === "failed" && job.attempts < job.max))) return [];
    if (mine.some((job) => ["manual_review", "completed", "skipped"].includes(job.status) && job.triggerState === state)) return [];
    const job = { id: `job${m.jobs.length + 1}`, entityId: id, triggerState: state, status: "pending", attempts: 0, max: Number(params[1]), queueJobId: null };
    m.jobs.push(job);
    return [{ id: job.id }];
  }
  if (sql.includes("SELECT id,payload FROM sync_jobs"))
    return m.jobs.filter((job) => job.status === "pending" && !job.queueJobId).map((job) => ({ id: job.id, payload: { entityId: job.entityId, triggerState: job.triggerState } }));
  if (sql.startsWith("UPDATE sync_jobs SET queue_job_id")) {
    const job = m.jobs.find((item) => item.id === id);
    if (job && !job.queueJobId) job.queueJobId = String(params[1]);
    return [];
  }
  if (sql.includes("SELECT o.shopify_order_id FROM order_mappings o")) {
    const active = m.jobs.some((job) => job.entityId === "1" && (["pending", "processing"].includes(job.status) || (job.status === "failed" && job.attempts < job.max)));
    return m.mapped && !m.invoice?.kiotviet_invoice_id && !active ? [{ shopify_order_id: "1" }] : [];
  }
  if (sql.startsWith("SELECT * FROM invoice_mappings")) return m.invoice ? [m.invoice] : [];
  if (sql.startsWith("SELECT status FROM invoice_mappings")) return m.invoice ? [{ status: m.invoice.status }] : m.blocked ? [{ status: m.blocked.status }] : [];
  if (sql.startsWith("SELECT shopify_order_id FROM invoice_mappings"))
    return m.blocked?.status === "blocked" && m.blocked.failure_stage === params[0] ? [{ shopify_order_id: "1" }] : [];
  if (sql.startsWith("UPDATE invoice_mappings SET failure_stage='invoice_index_retried'")) {
    if (m.blocked?.status === "blocked" && m.blocked.failure_stage === params[1]) m.blocked.failure_stage = "invoice_index_retried";
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings")) return [];
  throw new Error(`Unhandled SQL: ${sql.slice(0, 70)}`);
}

vi.mock("@/lib/db/client", () => ({ query: async (sql: string, params?: unknown[]) => run(sql, params) }));
vi.mock("@/lib/shopify/orders", () => ({ getShopifyOrderPaymentState: m.live }));
vi.mock("@/lib/queue/queues", () => ({ getQueue: () => ({ add: m.add }) }));
vi.mock("@/lib/redis/client", () => ({ isRedisEnabled: () => true }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ JOB_MAX_ATTEMPTS: 5 }) }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/recovery/kiotviet-invoice-recovery", () => ({ planInvoiceRecovery: m.plan, applyInvoiceRecovery: m.apply }));
vi.mock("@/lib/sync/sync-settings", () => ({ getSyncSettings: async () => ({ kiotVietInventoryToShopify: true, inventoryConflictStrategy: "hold" }) }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: m.stock }));
vi.mock("@/lib/kiotviet/invoice-index", () => ({ getInvoiceIndexHealth: async () => m.indexHealth }));

import {
  dispatchInvoiceOutbox,
  invoiceTriggerDecision,
  processFulfillmentInvoice,
  readmitIndexDeferredInvoices,
  reconcileFulfillmentInvoices,
  requestFulfillmentInvoice,
} from "@/lib/sync/fulfillment-invoice";
import { ConflictError, RetryableError } from "@/lib/errors";

const config = { invoiceCreationTrigger: "shopify_fulfilled" as const, invoiceTriggerEnabledAt: "2026-11-01T00:00:00Z", autoInvoice: false, kiotVietCurrency: "USD" };
const live = (overrides: Record<string, unknown> = {}) => ({
  createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T01:00:00Z", cancelledAt: null,
  displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", ...overrides,
});
const createdInvoice = { kiotviet_invoice_id: "8", status: "created", reconciliation: { branchId: 10, expectedLines: [{ productId: 2, sku: "sku", quantity: 1, price: 80 }] } };

beforeEach(() => {
  vi.resetAllMocks();
  m.config = { ...config };
  m.settingsVersion = "settings-v1";
  m.mapped = true;
  m.invoice = undefined;
  m.blocked = undefined;
  m.jobs = [];
  m.checkAt = undefined;
  m.indexHealth = { usable: true, scanned: 100, total: 100, lastError: null };
  m.live.mockResolvedValue(live());
  m.add.mockResolvedValue({});
  m.plan.mockResolvedValue({ action: { kind: "create_invoice" } });
  m.apply.mockImplementation(async () => { m.invoice = { ...createdInvoice }; return { applied: true }; });
  m.stock.mockResolvedValue({ status: "synced" });
});

describe("invoiceTriggerDecision", () => {
  it.each([["UNFULFILLED", "waiting"], ["FULFILLED", "ready"], ["PARTIALLY_FULFILLED", "partial"]])("fulfillment %s → %s", (status, expected) => {
    expect(invoiceTriggerDecision(config, live({ displayFulfillmentStatus: status }))).toBe(expected);
  });
  it("keeps the legacy setting and historical orders out", () => {
    expect(invoiceTriggerDecision({ autoInvoice: true }, live())).toBe("disabled");
    expect(invoiceTriggerDecision(config, live({ createdAt: "2026-10-01T00:00:00Z" }))).toBe("historical");
    expect(invoiceTriggerDecision({ ...config, invoiceCreationTrigger: "disabled" }, live())).toBe("disabled");
  });
  it.each([{ cancelledAt: "2026-11-03" }, { displayFinancialStatus: "REFUNDED" }])("blocks %j", (change) => {
    expect(invoiceTriggerDecision(config, live(change))).toBe("blocked");
  });
});

describe("admission (Shopify Fulfilled → invoice job)", () => {
  it("paid but unfulfilled creates no invoice job", async () => {
    m.live.mockResolvedValue(live({ displayFulfillmentStatus: "UNFULFILLED" }));
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("waiting");
    expect(m.jobs).toHaveLength(0);
  });

  it("fulfillment admits exactly one job for the existing KiotViet order", async () => {
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("admitted");
    expect(m.jobs).toMatchObject([{ entityId: "1", status: "pending", triggerState: "2026-11-02T01:00:00Z|settings-v1" }]);
    expect(m.add).toHaveBeenCalledWith("shopify_invoice_create", expect.objectContaining({ entityId: "1", auditJobId: "job1" }), expect.objectContaining({ jobId: "invoice-job1" }));
  });

  it("duplicate fulfillment webhooks reuse one job", async () => {
    await requestFulfillmentInvoice("1");
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("already_admitted");
    await requestFulfillmentInvoice("1");
    expect(m.jobs).toHaveLength(1);
    expect(m.add).toHaveBeenCalledOnce();
  });

  it("waits for the KiotViet order, then admits", async () => {
    m.mapped = false;
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("not_synced");
    m.mapped = true;
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("admitted");
  });

  it("never admits historical orders", async () => {
    m.live.mockResolvedValue(live({ createdAt: "2026-10-30T00:00:00Z" }));
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("historical");
    expect(m.jobs).toHaveLength(0);
    expect(m.checkAt).toBe("infinity");
  });

  it("records cancelled orders as blocked and stops rescanning them", async () => {
    m.live.mockResolvedValue(live({ cancelledAt: "2026-11-03T00:00:00Z" }));
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("blocked");
    expect(m.blocked).toMatchObject({ status: "blocked" });
    expect(m.checkAt).toBe("infinity");
  });

  it("repairs a failed Redis hand-off without a second database job", async () => {
    m.add.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(requestFulfillmentInvoice("1")).rejects.toThrow("Redis unavailable");
    expect(m.jobs).toHaveLength(1);
    await dispatchInvoiceOutbox();
    expect(m.jobs[0].queueJobId).toBe("invoice-job1");
    expect(m.add.mock.calls.map((call) => call[2].jobId)).toEqual(["invoice-job1", "invoice-job1"]);
  });
});

describe("partial → full fulfillment lifecycle (regression)", () => {
  it("partial fulfillment parks without a job, and the later full fulfillment is admitted", async () => {
    m.live.mockResolvedValue(live({ displayFulfillmentStatus: "PARTIALLY_FULFILLED", updatedAt: "t1" }));
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("partial");
    expect(m.jobs).toHaveLength(0);
    expect(m.blocked).toMatchObject({ status: "blocked", last_error: expect.stringContaining("partial_fulfillment") });
    expect(m.checkAt).not.toBe("infinity");

    m.live.mockResolvedValue(live({ displayFulfillmentStatus: "FULFILLED", updatedAt: "t2" }));
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("admitted");
    await processFulfillmentInvoice("1");
    expect(m.apply).toHaveBeenCalledOnce();
  });

  it("a job that finds the order only partially fulfilled completes, and full fulfillment admits a new job", async () => {
    await requestFulfillmentInvoice("1");
    m.live.mockResolvedValue(live({ displayFulfillmentStatus: "PARTIALLY_FULFILLED", updatedAt: "t3" }));
    await expect(processFulfillmentInvoice("1")).resolves.toBeUndefined();
    m.jobs[0].status = "completed";
    expect(m.apply).not.toHaveBeenCalled();

    m.live.mockResolvedValue(live({ displayFulfillmentStatus: "FULFILLED", updatedAt: "t4" }));
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("admitted");
    expect(m.jobs).toHaveLength(2);
  });

  it("does not repeat a manual-review job for the same state, but re-admits after the settings are fixed", async () => {
    await requestFulfillmentInvoice("1");
    m.jobs[0].status = "manual_review";
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("already_admitted");
    m.settingsVersion = "settings-v2"; // e.g. kiotVietCurrency configured
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("admitted");
  });

  it("re-admits an order whose job exhausted its retries (e.g. lookup not yet available)", async () => {
    await requestFulfillmentInvoice("1");
    Object.assign(m.jobs[0], { status: "failed", attempts: 5 });
    await reconcileFulfillmentInvoices();
    expect(m.jobs).toHaveLength(2);
  });

  it("never overwrites an uncertain (needs_review) invoice with blocked", async () => {
    m.blocked = { status: "needs_review", last_error: "create request timed out" };
    m.live.mockResolvedValue(live({ displayFulfillmentStatus: "PARTIALLY_FULFILLED" }));
    await requestFulfillmentInvoice("1");
    expect(m.blocked).toMatchObject({ status: "needs_review" });
  });
});

describe("processing an invoice job", () => {
  it("creates through the guarded recovery claim and syncs absolute stock", async () => {
    await processFulfillmentInvoice("1");
    expect(m.apply).toHaveBeenCalledOnce();
    expect(m.stock).toHaveBeenCalledWith(expect.objectContaining({ ProductId: 2, BranchId: 10 }), undefined, { refreshFromKiotViet: true, conflictStrategy: "hold" });
  });

  it("never creates a second invoice when one already exists", async () => {
    m.invoice = { ...createdInvoice };
    m.plan.mockResolvedValue({ action: { kind: "none" } });
    await processFulfillmentInvoice("1");
    expect(m.apply).not.toHaveBeenCalled();
  });

  it("retries (not manual review) while the invoice index cannot prove absence", async () => {
    m.plan.mockResolvedValue({ action: { kind: "blocked", reasons: ["invoice_lookup_incomplete: index not current"] } });
    await expect(processFulfillmentInvoice("1")).rejects.toBeInstanceOf(RetryableError);
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.blocked).toBeUndefined();
  });

  it("records financial blocks (e.g. missing currency) as blocked for manual review", async () => {
    m.plan.mockResolvedValue({ action: { kind: "blocked", reasons: ["kiotviet_currency_not_configured: set orders.kiotVietCurrency"] } });
    await expect(processFulfillmentInvoice("1")).rejects.toBeInstanceOf(ConflictError);
    expect(m.blocked).toMatchObject({ status: "blocked", last_error: expect.stringContaining("kiotviet_currency_not_configured") });
    expect(m.apply).not.toHaveBeenCalled();
  });

  it("does not resend when the invoice outcome is uncertain", async () => {
    m.apply.mockResolvedValue({ applied: false, message: "Outcome unknown (timeout); NOT resent" });
    await expect(processFulfillmentInvoice("1")).rejects.toThrow("NOT resent");
    expect(m.apply).toHaveBeenCalledOnce();
  });

  it("keeps stock conflicts from turning into a second invoice", async () => {
    m.invoice = { ...createdInvoice };
    m.plan.mockResolvedValue({ action: { kind: "none" } });
    m.stock.mockResolvedValue({ status: "held" });
    await expect(processFulfillmentInvoice("1")).rejects.toThrow("inventory synchronization requires review");
    expect(m.apply).not.toHaveBeenCalled();
  });
});

describe("invoice index automation (invoice_lookup_incomplete without manual commands)", () => {
  it("defers cheaply while the index is rebuilding: no plan, no remote reads, no attempt consumed", async () => {
    m.indexHealth = { usable: false, scanned: 2_000, total: 13_215, lastError: "overlap mismatch" };
    await expect(processFulfillmentInvoice("1")).resolves.toBeUndefined();
    expect(m.plan).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.blocked).toMatchObject({ status: "blocked", failure_stage: "invoice_index", last_error: expect.stringContaining("invoice_index_not_ready") });
  });

  it("re-admits the deferred job exactly once after the index becomes current, then invoices", async () => {
    await requestFulfillmentInvoice("1");
    m.indexHealth = { usable: false, scanned: 0, total: null, lastError: null };
    await processFulfillmentInvoice("1");
    m.jobs[0].status = "completed";
    // Same Shopify/settings state: the rescan alone does not loop on it.
    await expect(requestFulfillmentInvoice("1")).resolves.toBe("already_admitted");

    m.indexHealth = { usable: true, scanned: 13_215, total: 13_215, lastError: null };
    const asOf = new Date("2026-11-05T01:00:00Z");
    await expect(readmitIndexDeferredInvoices(asOf)).resolves.toEqual({ "1": "admitted" });
    expect(m.jobs[1].triggerState).toContain("|index:2026-11-05T01:00:00.000Z");
    await processFulfillmentInvoice("1");
    expect(m.apply).toHaveBeenCalledOnce();
    // The deferral is consumed: a later index run does not re-admit it again.
    m.jobs[1].status = "completed";
    await expect(readmitIndexDeferredInvoices(new Date())).resolves.toEqual({});
  });

  it("never defers an attempt whose POST may have been sent; it keeps the retry → link/review path", async () => {
    m.indexHealth = { usable: false, scanned: 10, total: 13_215, lastError: null };
    m.invoice = { status: "creating" };
    await expect(processFulfillmentInvoice("1")).rejects.toBeInstanceOf(RetryableError);
    expect(m.blocked).toBeUndefined();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it("backs off re-checks of an order whose jobs keep failing", async () => {
    await requestFulfillmentInvoice("1");
    expect(m.checkAt).toBe("+30m"); // interval '30 minutes' × 2^(exhausted jobs), capped at 24 hours
  });
});

describe("Shopify payment status as the trigger authority", () => {
  it.each([
    ["PAID", "shopify_paid", "UNFULFILLED", "ready"],
    ["PARTIALLY_REFUNDED", "shopify_paid", "UNFULFILLED", "ready"],
    ["PENDING", "shopify_paid", "UNFULFILLED", "waiting"],
    ["AUTHORIZED", "shopify_paid", "UNFULFILLED", "waiting"],
    ["PARTIALLY_PAID", "shopify_fulfilled", "FULFILLED", "waiting"],
    ["PAID", "shopify_fulfilled", "UNFULFILLED", "waiting"],
    ["PAID", "shopify_fulfilled", "FULFILLED", "ready"],
    ["REFUNDED", "shopify_paid", "UNFULFILLED", "blocked"],
  ])("%s with trigger %s and %s → %s", (financial, trigger, fulfillment, expected) => {
    expect(invoiceTriggerDecision({ ...config, invoiceCreationTrigger: trigger as "shopify_paid" },
      live({ displayFinancialStatus: financial, displayFulfillmentStatus: fulfillment }))).toBe(expected);
  });

  it("re-checks the live trigger right before applying (payment status changed during validation)", async () => {
    m.live.mockResolvedValueOnce(live()).mockResolvedValueOnce(live({ displayFinancialStatus: "REFUNDED" }));
    await expect(processFulfillmentInvoice("1")).rejects.toThrow("Invoice trigger changed during validation");
    expect(m.apply).not.toHaveBeenCalled();
  });
});
