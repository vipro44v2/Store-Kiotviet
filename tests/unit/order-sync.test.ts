import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyOrderWebhook } from "@/types/shopify";

interface Row {
  status: string | null;
  kiotviet_order_id: string | null;
  kiotviet_order_code: string | null;
  claim_token: string | null;
  claimed_at: Date | null;
  created_at: Date;
  sync_status: string | null;
  last_error: string | null;
  failure_stage: string | null;
}

const mocks = vi.hoisted(() => ({
  ensureMapping: vi.fn(),
  resolveBranch: vi.fn(),
  createOrder: vi.fn(),
  findOrder: vi.fn(),
  updateCustomer: vi.fn(),
  cancelOrder: vi.fn(),
  syncCustomer: vi.fn(),
  log: vi.fn(),
  findInvoices: vi.fn(),
  invoiceDetail: vi.fn(),
  getProduct: vi.fn(),
  db: {
    invoices: new Map<string, Record<string, unknown>>(),
    locationMapped: true,
    rows: new Map<string, Row>(),
    orders: {} as Record<string, unknown>,
    customers: new Map<string, string>(),
  },
}));

/** invoice_mappings statements from lib/sync/invoice-sync.ts, honoring their guards. */
function runInvoice(sql: string, params: unknown[]): Record<string, unknown>[] | undefined {
  const { db } = mocks;
  const id = String(params[0]);
  const invoice = db.invoices.get(id);
  if (sql.includes("FROM branch_location_mappings")) return db.locationMapped ? [{ "?column?": 1 }] : [];
  if (sql.startsWith("SELECT kiotviet_order_id::text,kiotviet_order_code FROM order_mappings")) {
    const row = db.rows.get(id);
    return row ? [{ kiotviet_order_id: row.kiotviet_order_id, kiotviet_order_code: row.kiotviet_order_code }] : [];
  }
  if (!sql.includes("invoice_mappings")) return undefined;
  if (sql.startsWith("SELECT 1 FROM invoice_mappings"))
    return invoice && ["pending", "creating", "created", "needs_review"].includes(String(invoice.status)) ? [{}] : [];
  if (sql.startsWith("SELECT")) return invoice ? [{ ...invoice }] : [];
  if (sql.startsWith("INSERT INTO invoice_mappings")) {
    if (invoice && (invoice.kiotviet_invoice_id || !["pending", "failed", "blocked"].includes(String(invoice.status)))) return [];
    db.invoices.set(id, {
      ...(invoice ?? { shopify_order_id: id, kiotviet_order_id: null, kiotviet_order_code: null, kiotviet_invoice_id: null, created_at: new Date(), reconciliation: {} }),
      status: params[1], source: "auto", claim_token: params[2], claimed_at: new Date(), expected_total: params[3] == null ? null : String(params[3]),
      currency: params[4], last_error: params[5], failure_stage: params[6],
    });
    return [{ status: params[1] }];
  }
  if (!invoice) return [];
  const token = invoice.claim_token === params[1];
  if (sql.startsWith("UPDATE invoice_mappings SET status='blocked'")) {
    if (invoice.status === "pending" && token) Object.assign(invoice, { status: "blocked", claim_token: null, last_error: params[2] });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status='creating'")) {
    if (invoice.status !== "pending" || !token) return [];
    Object.assign(invoice, { status: "creating", reconciliation: JSON.parse(String(params[2])) });
    return [{ shopify_order_id: id }];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status='failed'")) {
    if (["pending", "creating"].includes(String(invoice.status)) && token) Object.assign(invoice, { status: "failed", claim_token: null });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_order_id=$2")) {
    if (!invoice.kiotviet_order_id) Object.assign(invoice, { kiotviet_order_id: String(params[1]), kiotviet_order_code: params[2] });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status='needs_review'")) {
    if (!invoice.kiotviet_invoice_id) Object.assign(invoice, { status: "needs_review", last_error: params[2] });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_invoice_id=$2")) {
    if (invoice.kiotviet_invoice_id) return [];
    for (const other of db.invoices.values())
      if (other !== invoice && other.kiotviet_invoice_id === String(params[1])) throw new Error("duplicate key kiotviet_invoice_id");
    Object.assign(invoice, { kiotviet_invoice_id: String(params[1]), kiotviet_invoice_code: params[2], status: params[3], reconciliation: JSON.parse(String(params[4])), last_error: params[5] });
    return [{ shopify_order_id: id }];
  }
  throw new Error(`Unhandled invoice SQL in fake: ${sql.slice(0, 80)}`);
}

/** Minimal order_mappings store that honors the WHERE guards order-sync relies on. */
function run(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const { db } = mocks;
  const id = String(params[0]);
  const row = db.rows.get(id);
  const now = new Date();
  if (sql.includes("pg_advisory_xact_lock")) return [];
  const invoiceRows = runInvoice(sql, params);
  if (invoiceRows) return invoiceRows;
  if (sql.includes("FROM system_settings")) return [{ value: db.orders }];
  if (sql.includes("FROM customer_mappings"))
    return db.customers.has(id) ? [{ kiotviet_customer_id: db.customers.get(id) }] : [];
  if (sql.startsWith("SELECT kiotviet_order_id,status"))
    return row ? [{ ...row }] : [];
  if (sql.startsWith("INSERT INTO order_mappings") && sql.includes("VALUES($1,$2,'pending_create'")) {
    if (row) throw new Error("duplicate key value violates unique constraint");
    db.rows.set(id, {
      status: "pending_create", kiotviet_order_id: null, kiotviet_order_code: null,
      claim_token: String(params[4]), claimed_at: now, created_at: now,
      sync_status: "pending", last_error: null, failure_stage: null,
    });
    return [];
  }
  if (sql.startsWith("INSERT INTO order_mappings") && sql.includes("'create_failed'")) {
    const failed = { status: "create_failed", sync_status: String(params[4]), last_error: String(params[5]), failure_stage: String(params[6]) };
    if (!row)
      db.rows.set(id, { kiotviet_order_id: null, kiotviet_order_code: null, claim_token: null, claimed_at: null, created_at: now, ...failed });
    else if (!row.kiotviet_order_id && row.status !== "creating" && row.status !== "pending_create")
      Object.assign(row, failed);
    return [];
  }
  if (!row) return [];
  const tokenMatches = row.claim_token === params[1];
  if (sql.startsWith("UPDATE order_mappings SET status='pending_create'")) {
    Object.assign(row, { status: "pending_create", claim_token: String(params[1]), claimed_at: now });
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET status='creating'")) {
    if (row.status !== "pending_create" || !tokenMatches) return [];
    Object.assign(row, { status: "creating", claimed_at: now });
    return [{ shopify_order_id: id }];
  }
  if (sql.startsWith("UPDATE order_mappings SET status='create_failed',sync_status=$3")) {
    if (row.status === "pending_create" && tokenMatches)
      Object.assign(row, { status: "create_failed", sync_status: params[2], claim_token: null, last_error: params[3], failure_stage: params[4] });
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET status='create_failed',sync_status='failed'")) {
    if (row.status === "creating" && tokenMatches)
      Object.assign(row, { status: "create_failed", sync_status: "failed", claim_token: null, last_error: params[2], failure_stage: params[3] });
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET sync_status='uncertain'")) {
    if (row.status === "creating" && tokenMatches)
      Object.assign(row, { sync_status: "uncertain", last_error: params[2], failure_stage: params[3] });
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET kiotviet_order_id=$3")) {
    if (row.status !== "creating" || !tokenMatches) return [];
    Object.assign(row, { status: "created", kiotviet_order_id: String(params[2]), kiotviet_order_code: String(params[3]), claim_token: null, sync_status: "synced" });
    return [{ shopify_order_id: id }];
  }
  if (sql.startsWith("UPDATE order_mappings SET kiotviet_order_id=$2")) {
    if (row.status === "creating" && !row.kiotviet_order_id)
      Object.assign(row, { status: "created", kiotviet_order_id: String(params[1]), kiotviet_order_code: String(params[2]), sync_status: "synced" });
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET sync_status='manual_review'")) {
    if (row.status === "creating") Object.assign(row, { sync_status: "manual_review", failure_stage: params[1] });
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET status=COALESCE")) {
    row.status = row.status ?? "created";
    row.sync_status = "synced";
    return [];
  }
  if (sql.startsWith("UPDATE order_mappings SET status='cancelled'")) {
    row.status = "cancelled";
    return [];
  }
  throw new Error(`Unhandled SQL in fake: ${sql.slice(0, 80)}`);
}

vi.mock("@/lib/db/client", () => {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    query: async (sql: string, params?: unknown[]) => run(sql, params),
    // Serialized like pg_advisory_xact_lock.
    transaction: (callback: (client: unknown) => Promise<unknown>) => {
      const result = chain.then(() =>
        callback({
          query: async (sql: string, params?: unknown[]) => {
            const rows = run(sql, params);
            return { rows, rowCount: rows.length };
          },
        }),
      );
      chain = result.catch(() => undefined);
      return result;
    },
  };
});
vi.mock("@/lib/sync/ensure-product-mapping", () => ({ ensureProductMapping: mocks.ensureMapping }));
vi.mock("@/lib/sync/default-branch", () => ({ resolveDefaultBranchId: mocks.resolveBranch }));
vi.mock("@/lib/kiotviet/orders", () => ({
  createKiotVietOrder: mocks.createOrder,
  cancelKiotVietOrder: mocks.cancelOrder,
  findKiotVietOrderByShopifyReference: mocks.findOrder,
  updateKiotVietOrderCustomer: mocks.updateCustomer,
}));
vi.mock("@/lib/sync/customer-sync", () => ({ syncShopifyCustomer: mocks.syncCustomer }));
vi.mock("@/lib/shopify/orders", () => ({ cancelShopifyOrderById: vi.fn(), fulfillShopifyOrderById: vi.fn() }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/kiotviet/invoices", () => ({
  findKiotVietInvoicesForOrder: mocks.findInvoices,
  getKiotVietInvoiceDetail: mocks.invoiceDetail,
  KIOTVIET_INVOICE_CANCELLED: 2,
}));
vi.mock("@/lib/kiotviet/products", () => ({ getKiotVietProduct: mocks.getProduct }));

import { cancelShopifyOrder, syncShopifyOrder } from "@/lib/sync/order-sync";
import { normalizeSku } from "@/lib/sync/mappings";
import {
  ApiError,
  ConflictError,
  MappingError,
  RetryableError,
  UncertainResultError,
} from "@/lib/errors";
import { isManualReview } from "@/lib/queue/worker";

function order(overrides: Partial<ShopifyOrderWebhook> = {}): ShopifyOrderWebhook {
  return {
    id: 5001,
    name: "#1001",
    created_at: "2026-11-01T00:00:00Z",
    financial_status: "paid",
    fulfillment_status: null,
    total_price: "300000",
    customer: null,
    line_items: [{ id: 11, sku: "NU012", quantity: 2, price: "150000", name: "Áo thun" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.rows.clear();
  mocks.db.invoices.clear();
  mocks.db.locationMapped = true;
  mocks.db.customers.clear();
  mocks.db.orders = { autoCreate: true, paidOnly: true, syncCustomers: true };
  mocks.resolveBranch.mockResolvedValue(10);
  mocks.ensureMapping.mockImplementation(async (sku: string) => ({ kiotviet_product_id: sku === "NU013" ? "502" : "501" }));
  mocks.createOrder.mockResolvedValue({ id: 700, code: "DH700" });
  mocks.findOrder.mockResolvedValue(undefined);
  mocks.syncCustomer.mockResolvedValue({ created: false });
  mocks.log.mockResolvedValue(undefined);
});

describe("normalizeSku", () => {
  it.each([null, undefined, "", "   "])("returns an empty key for %j instead of throwing", (value) => {
    expect(normalizeSku(value)).toBe("");
  });
  it("normalizes a valid SKU", () => expect(normalizeSku(" nu012 ")).toBe("NU012"));
});

describe("Shopify order → KiotViet", () => {
  it("creates a valid order once and records the mapping", async () => {
    await expect(syncShopifyOrder(order())).resolves.toEqual({ action: "created", kiotVietOrderId: "700" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      branchId: 10,
      customer: undefined,
      description: "Shopify #1001 (5001)",
      orderDetails: [expect.objectContaining({ productId: 501, productCode: "NU012", quantity: 2, price: 150000 })],
    }));
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "created", kiotviet_order_id: "700", claim_token: null });
  });

  it.each([
    ["null SKU", null, "no SKU"],
    ["empty SKU", "", "an empty SKU"],
    ["whitespace SKU", "  ", "an empty SKU"],
  ])("rejects a line with a %s as a manual-review MappingError without creating anything", async (_label, sku, text) => {
    const payload = order({
      line_items: [
        { id: 11, sku: "NU012", quantity: 1, price: "100", name: "Mapped" },
        { id: 12, sku, quantity: 1, price: "100", name: "Custom item" },
      ],
    });
    const error = await syncShopifyOrder(payload, { jobType: "shopify_order_update", eventId: "evt-1" }).catch((e) => e);
    expect(error).toBeInstanceOf(MappingError);
    expect(isManualReview(error)).toBe(true);
    expect(error.message).toContain("Shopify order #1001 (5001)");
    expect(error.message).toContain(`line item 12 "Custom item" has ${text}`);
    expect(error.details).toMatchObject({ shopifyOrderId: "5001", lineItemId: "12", mappingStatus: "missing_sku" });
    expect(mocks.ensureMapping).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "create_failed", sync_status: "manual_review", failure_stage: "validate_line_items" });
  });

  it("logs structured diagnostics without customer PII", async () => {
    const payload = order({
      customer: { id: 9, email: "buyer@example.com", phone: "0900000000", default_address: { address1: "1 Secret St" } },
      line_items: [{ id: 12, sku: null, quantity: 1, price: "100", name: "Custom" }],
    });
    await expect(syncShopifyOrder(payload, { jobType: "shopify_order_update", eventId: "evt-1", jobId: "job-1" })).rejects.toThrow(MappingError);
    expect(mocks.log).toHaveBeenCalledWith("warn", "Shopify order sync failed", expect.objectContaining({
      action: "order_sync_failed",
      shopifyOrderId: "5001",
      shopifyOrderName: "#1001",
      jobType: "shopify_order_update",
      eventId: "evt-1",
      jobId: "job-1",
      errorClass: "MappingError",
      failureStage: "validate_line_items",
      lineItemId: "12",
      sku: null,
      mappingStatus: "missing_sku",
      retryable: false,
    }));
    const logged = JSON.stringify(mocks.log.mock.calls);
    expect(logged).not.toContain("buyer@example.com");
    expect(logged).not.toContain("0900000000");
    expect(logged).not.toContain("Secret St");
  });

  it("creates a guest checkout order (customer=null) without a customer", async () => {
    await syncShopifyOrder(order({ customer: null }));
    expect(mocks.syncCustomer).not.toHaveBeenCalled();
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ customer: undefined }));
  });

  it("treats a customer object without an ID as a guest instead of inventing one", async () => {
    await syncShopifyOrder(order({ customer: { id: null, email: null, first_name: null } }));
    expect(mocks.syncCustomer).not.toHaveBeenCalled();
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ customer: undefined }));
  });

  it("still creates the order when customer sync is disabled", async () => {
    mocks.db.orders.syncCustomers = false;
    await syncShopifyOrder(order({ customer: { id: 9, first_name: "An" } }));
    expect(mocks.syncCustomer).not.toHaveBeenCalled();
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ customer: undefined }));
  });

  it("keeps the existing customer mapping behavior when customer sync is enabled", async () => {
    mocks.db.customers.set("9", "880");
    await syncShopifyCustomerOrder();
    expect(mocks.syncCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), 10);
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: 880 } }));
  });
  async function syncShopifyCustomerOrder() {
    await syncShopifyOrder(order({ customer: { id: 9, first_name: null, last_name: null, email: null, phone: null, default_address: null, addresses: null } }));
  }

  it("does not create an incomplete order when a product mapping is missing", async () => {
    mocks.ensureMapping.mockImplementation(async (sku: string) => {
      if (sku === "NU013") throw new MappingError("Cannot auto-map SKU NU013", { sku, mappingStatus: "unmapped" });
      return { kiotviet_product_id: "501" };
    });
    const payload = order({ line_items: [
      { id: 11, sku: "NU012", quantity: 1, price: "100", name: "A" },
      { id: 13, sku: "NU013", quantity: 1, price: "100", name: "B" },
    ] });
    const error = await syncShopifyOrder(payload).catch((e) => e);
    expect(error).toBeInstanceOf(MappingError);
    expect(error.details).toMatchObject({ lineItemId: "13", sku: "NU013", mappingStatus: "unmapped" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
    // Nothing was sent, so the claim is released and the next webhook may retry.
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "create_failed", failure_stage: "product_mapping", claim_token: null });
  });

  it("routes duplicate SKU mappings to manual review without creating the order", async () => {
    mocks.ensureMapping.mockRejectedValue(new MappingError("Multiple product mappings exist for SKU NU012", { sku: "NU012", mappingStatus: "duplicate_mapping" }));
    const error = await syncShopifyOrder(order()).catch((e) => e);
    expect(isManualReview(error)).toBe(true);
    expect(error.details.mappingStatus).toBe("duplicate_mapping");
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("re-claims a create_failed order on a later update once mappings are fixed", async () => {
    mocks.ensureMapping.mockRejectedValueOnce(new MappingError("unmapped"));
    await expect(syncShopifyOrder(order())).rejects.toThrow(MappingError);
    await expect(syncShopifyOrder(order(), { jobType: "shopify_order_update" })).resolves.toMatchObject({ action: "created" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
  });

  it("skips unpaid orders while paidOnly is enabled", async () => {
    await expect(syncShopifyOrder(order({ financial_status: "pending" }))).resolves.toEqual({ action: "skipped", reason: "awaiting_payment" });
    expect(mocks.db.rows.has("5001")).toBe(false);
  });

  it("does not create a KiotViet order for a cancelled Shopify order", async () => {
    await expect(syncShopifyOrder(order({ cancelled_at: "2026-11-01T01:00:00Z" }))).resolves.toEqual({ action: "skipped", reason: "shopify_order_cancelled" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });
});

describe("shopify_order_update for existing mapped orders", () => {
  it("updates the mapping status without creating a second KiotViet order", async () => {
    await syncShopifyOrder(order());
    await expect(syncShopifyOrder(order({ fulfillment_status: "fulfilled" }), { jobType: "shopify_order_update" }))
      .resolves.toEqual({ action: "updated", kiotVietOrderId: "700" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
  });

  it("does not validate SKUs of an already created order", async () => {
    await syncShopifyOrder(order());
    const update = order({ line_items: [{ id: 99, sku: null, quantity: 1, price: "1", name: "Added later" }] });
    await expect(syncShopifyOrder(update, { jobType: "shopify_order_update" })).resolves.toMatchObject({ action: "updated" });
  });

  it("updates the KiotViet order customer for a mapped order when customer sync is enabled", async () => {
    await syncShopifyOrder(order());
    mocks.db.customers.set("9", "880");
    await syncShopifyOrder(order({ customer: { id: 9 } }), { jobType: "shopify_order_update" });
    expect(mocks.updateCustomer).toHaveBeenCalledWith(700, 880);
  });

  it("does not overwrite a cancellation recorded concurrently", async () => {
    await syncShopifyOrder(order());
    mocks.db.rows.get("5001")!.status = "cancelled";
    await syncShopifyOrder(order(), { jobType: "shopify_order_update" });
    expect(mocks.db.rows.get("5001")!.status).toBe("cancelled");
  });
});

describe("concurrency and uncertain KiotViet responses", () => {
  it("creates exactly one KiotViet order for concurrent create/update webhooks", async () => {
    let release!: () => void;
    mocks.createOrder.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ id: 700, code: "DH700" }); }));
    const create = syncShopifyOrder(order(), { jobType: "shopify_order_create" });
    await vi.waitFor(() => expect(mocks.createOrder).toHaveBeenCalledOnce());
    const results = await Promise.allSettled([
      syncShopifyOrder(order(), { jobType: "shopify_order_update" }),
      syncShopifyOrder(order(), { jobType: "shopify_order_update" }),
    ]);
    release();
    await expect(create).resolves.toMatchObject({ action: "created" });
    // The in-flight order is verified, never re-sent; the duplicates retry later.
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(RetryableError);
    }
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    await expect(syncShopifyOrder(order(), { jobType: "shopify_order_update" })).resolves.toMatchObject({ action: "updated" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
  });

  it("serializes concurrent claims so only one job reaches KiotViet", async () => {
    const results = await Promise.allSettled([
      syncShopifyOrder(order(), { jobType: "shopify_order_create" }),
      syncShopifyOrder(order(), { jobType: "shopify_order_update" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(mocks.createOrder).toHaveBeenCalledOnce();
  });

  it("leaves an uncertain create in 'creating' and recovers the existing KiotViet order on retry", async () => {
    mocks.createOrder.mockRejectedValueOnce(new UncertainResultError("timeout"));
    await expect(syncShopifyOrder(order())).rejects.toBeInstanceOf(UncertainResultError);
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "creating", sync_status: "uncertain" });

    mocks.findOrder.mockResolvedValueOnce({ id: 700, code: "DH700" });
    await expect(syncShopifyOrder(order())).resolves.toEqual({ action: "recovered", kiotVietOrderId: "700" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "created", kiotviet_order_id: "700" });
  });

  it("retries inside the recovery window and never re-sends an uncertain create afterwards", async () => {
    mocks.createOrder.mockRejectedValueOnce(new UncertainResultError("KiotViet 503"));
    await expect(syncShopifyOrder(order())).rejects.toThrow(UncertainResultError);

    await expect(syncShopifyOrder(order())).rejects.toBeInstanceOf(RetryableError);

    mocks.db.rows.get("5001")!.claimed_at = new Date(Date.now() - 10 * 60_000);
    const error = await syncShopifyOrder(order()).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(isManualReview(error)).toBe(true);
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "creating", sync_status: "manual_review" });
  });

  it("allows a clean retry after KiotViet definitely rejected the order", async () => {
    mocks.createOrder.mockRejectedValueOnce(new ApiError("KiotViet API error (400): invalid product", 400));
    await expect(syncShopifyOrder(order())).rejects.toBeInstanceOf(ApiError);
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "create_failed", claim_token: null });
    await expect(syncShopifyOrder(order())).resolves.toMatchObject({ action: "created" });
    expect(mocks.createOrder).toHaveBeenCalledTimes(2);
  });

  it("takes over a stale pending_create claim (no request was sent)", async () => {
    mocks.db.rows.set("5001", {
      status: "pending_create", kiotviet_order_id: null, kiotviet_order_code: null, claim_token: "dead-worker",
      claimed_at: new Date(Date.now() - 60 * 60_000), created_at: new Date(Date.now() - 60 * 60_000),
      sync_status: "pending", last_error: null, failure_stage: null,
    });
    await expect(syncShopifyOrder(order())).resolves.toMatchObject({ action: "created" });
  });
});

describe("Shopify cancellation → KiotViet", () => {
  it("cancels a mapped KiotViet order once", async () => {
    await syncShopifyOrder(order());
    await cancelShopifyOrder(order());
    await cancelShopifyOrder(order());
    expect(mocks.cancelOrder).toHaveBeenCalledOnce();
    expect(mocks.cancelOrder).toHaveBeenCalledWith(700);
  });

  it("waits while the KiotViet order is still being created", async () => {
    mocks.createOrder.mockRejectedValueOnce(new UncertainResultError("timeout"));
    await expect(syncShopifyOrder(order())).rejects.toThrow();
    await expect(cancelShopifyOrder(order())).rejects.toBeInstanceOf(RetryableError);
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps routing an unmapped cancellation to manual review", async () => {
    await expect(cancelShopifyOrder(order())).rejects.toBeInstanceOf(MappingError);
  });
});

describe("processing fees (Shopify #1081)", () => {
  const fee = {
    id: 15977877143736, sku: null, quantity: 1, price: "9000.00",
    title: "SVC Fee - Credit Card Processing Fee", name: "SVC Fee - Credit Card Processing Fee",
  };
  const product = { id: 11, sku: "NU012", quantity: 2, price: "150000.00", name: "Áo thun", title: "Áo thun" };
  const feeOrder = (overrides: Partial<ShopifyOrderWebhook> = {}) =>
    order({ id: 7128306221240, name: "#1081", total_price: "309000.00", line_items: [product, fee], ...overrides });

  it("excludes the fee line from the KiotViet order and from the payment", async () => {
    await expect(syncShopifyOrder(feeOrder())).resolves.toMatchObject({ action: "created" });
    const input = mocks.createOrder.mock.calls[0][0];
    expect(input.orderDetails).toHaveLength(1);
    expect(input.orderDetails[0]).toMatchObject({ productCode: "NU012", quantity: 2, price: 150000 });
    expect(input.totalPayment).toBe(300000);
    expect(mocks.ensureMapping).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith("info", "Shopify order amounts adjusted for KiotViet", expect.objectContaining({
      action: "order_fees_excluded",
      shopifyTotal: 309000, excludedFeeTotal: 9000, adjustedKiotVietTotal: 300000, kiotVietLineTotal: 300000, totalPayment: 300000,
      excludedFeeLines: [expect.objectContaining({ lineItemId: "15977877143736", reason: "exact_title_without_sku", amount: 9000 })],
    }));
  });

  it("excludes only the fee's charged amount when the fee is discounted", async () => {
    await syncShopifyOrder(feeOrder({
      total_price: "306000.00",
      line_items: [product, { ...fee, discount_allocations: [{ amount: "3000.00" }] }],
    }));
    expect(mocks.createOrder.mock.calls[0][0].totalPayment).toBe(300000);
  });

  it("accounts for taxes added on top of the fee and shipping", async () => {
    await syncShopifyOrder(feeOrder({
      taxes_included: false,
      total_price: "339900.00",
      shipping_lines: [{ price: "30000.00", discounted_price: "30000.00" }],
      line_items: [product, { ...fee, tax_lines: [{ price: "900.00" }] }],
    }));
    expect(mocks.createOrder.mock.calls[0][0].totalPayment).toBe(330000);
    expect(mocks.log).toHaveBeenCalledWith("info", expect.any(String), expect.objectContaining({ excludedFeeTotal: 9900, expectedAdjustedTotal: 330000 }));
  });

  it("never creates an empty KiotViet order for a fee-only order", async () => {
    await expect(syncShopifyOrder(feeOrder({ total_price: "9000.00", line_items: [fee] })))
      .resolves.toEqual({ action: "skipped", reason: "fee_only_order" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.db.rows.has("7128306221240")).toBe(false);
  });

  it("still rejects a genuine product without SKU next to a fee", async () => {
    const error = await syncShopifyOrder(feeOrder({
      line_items: [product, fee, { id: 77, sku: null, quantity: 1, price: "50000", title: "Custom item", name: "Custom item" }],
    })).catch((e) => e);
    expect(error).toBeInstanceOf(MappingError);
    expect(error.details).toMatchObject({ lineItemId: "77", mappingStatus: "missing_sku" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("does not treat a product with a SKU as a fee just because its title matches", async () => {
    await syncShopifyOrder(feeOrder({ total_price: "9000.00", line_items: [{ ...fee, sku: "FEE-SKU" }] }));
    expect(mocks.ensureMapping).toHaveBeenCalledWith("FEE-SKU", undefined);
    expect(mocks.createOrder.mock.calls[0][0].orderDetails).toHaveLength(1);
  });

  it("uses configured fee variant IDs and leaves the title fallback off when titles are configured empty", async () => {
    mocks.db.orders = { ...mocks.db.orders, processingFeeVariantIds: [555], processingFeeTitles: [] };
    await syncShopifyOrder(feeOrder({
      total_price: "305000.00",
      line_items: [product, { id: 90, sku: "CARD-FEE", quantity: 1, price: "5000", title: "Phí cà thẻ", variant_id: 555 }],
    }));
    expect(mocks.createOrder.mock.calls[0][0]).toMatchObject({ totalPayment: 300000, orderDetails: [expect.objectContaining({ productCode: "NU012" })] });
    mocks.createOrder.mockClear();
    mocks.db.rows.clear();
    await expect(syncShopifyOrder(feeOrder())).rejects.toBeInstanceOf(MappingError);
  });
});

describe("Auto Invoice (orders.autoInvoice)", () => {
  const stock: Record<string, number> = {};
  const invoiceOrder = (overrides: Partial<ShopifyOrderWebhook> = {}) => order({ currency: "VND", ...overrides });
  const fee = { id: 15977877143736, sku: null, quantity: 1, price: "9000", title: "SVC Fee - Credit Card Processing Fee" };

  beforeEach(() => {
    mocks.db.orders = { autoCreate: true, paidOnly: true, syncCustomers: true, autoInvoice: true, kiotVietCurrency: "VND" };
    stock["501"] = 10;
    mocks.getProduct.mockImplementation(async (id: number) => ({ id, inventories: [{ branchId: 10, onHand: stock[String(id)] }] }));
    // KiotViet deducts stock when makeInvoice creates the invoice.
    mocks.createOrder.mockImplementation(async (input: { makeInvoice: boolean; orderDetails: Array<{ productId: number; quantity: number }> }) => {
      if (input.makeInvoice) for (const detail of input.orderDetails) stock[String(detail.productId)] -= detail.quantity;
      return { id: 700, code: "DH700" };
    });
    mocks.findInvoices.mockResolvedValue({
      invoices: [{ id: 9001, code: "HD9001", orderCode: "DH700", status: 1, statusValue: "Completed" }], complete: true,
    });
    mocks.invoiceDetail.mockResolvedValue({ id: 9001, code: "HD9001", orderCode: "DH700", status: 1, total: 300000, totalPayment: 300000 });
  });

  it("creates the order with makeInvoice, verifies the invoice and stock movement, and saves both IDs", async () => {
    await expect(syncShopifyOrder(invoiceOrder())).resolves.toEqual({ action: "created", kiotVietOrderId: "700", invoiceStatus: "created" });
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ makeInvoice: true, totalPayment: 300000 }));
    expect(mocks.db.rows.get("5001")).toMatchObject({ kiotviet_order_id: "700" });
    expect(mocks.db.invoices.get("5001")).toMatchObject({
      status: "created", source: "auto", kiotviet_order_id: "700", kiotviet_invoice_id: "9001", kiotviet_invoice_code: "HD9001",
      reconciliation: expect.objectContaining({ branchId: 10, stockBefore: { 501: 10 }, stockAfter: { 501: 8 }, stockVerified: true }),
    });
  });

  it("keeps the order-only behavior when Auto Invoice is disabled", async () => {
    mocks.db.orders.autoInvoice = false;
    await expect(syncShopifyOrder(invoiceOrder())).resolves.toEqual({ action: "created", kiotVietOrderId: "700" });
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ makeInvoice: false }));
    expect(mocks.db.invoices.size).toBe(0);
    expect(stock["501"]).toBe(10);
  });

  it("never invoices an order that already existed when the setting was enabled", async () => {
    mocks.db.orders.autoInvoice = false;
    await syncShopifyOrder(invoiceOrder());
    mocks.db.orders.autoInvoice = true;
    await expect(syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" })).resolves.toEqual({ action: "updated", kiotVietOrderId: "700" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(mocks.findInvoices).not.toHaveBeenCalled();
    expect(mocks.db.invoices.size).toBe(0);
  });

  it("handles repeated webhooks without a second order, invoice or lookup", async () => {
    await syncShopifyOrder(invoiceOrder());
    await syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" });
    await syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(mocks.findInvoices).toHaveBeenCalledOnce();
    expect(stock["501"]).toBe(8);
  });

  it("links the invoice after a timeout even though KiotViet created it (no resend)", async () => {
    mocks.createOrder.mockImplementationOnce(async () => { stock["501"] -= 2; throw new UncertainResultError("timeout"); });
    await expect(syncShopifyOrder(invoiceOrder())).rejects.toBeInstanceOf(UncertainResultError);
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "creating" });
    mocks.findOrder.mockResolvedValueOnce({ id: 700, code: "DH700" });
    await expect(syncShopifyOrder(invoiceOrder())).resolves.toMatchObject({ action: "recovered", invoiceStatus: "created" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "created", kiotviet_invoice_id: "9001" });
  });

  it("retries while the invoice is not visible yet, then links it from the next webhook", async () => {
    mocks.findInvoices.mockResolvedValueOnce({ invoices: [], complete: true });
    await expect(syncShopifyOrder(invoiceOrder())).rejects.toBeInstanceOf(RetryableError);
    expect(mocks.db.rows.get("5001")).toMatchObject({ status: "created" });
    await expect(syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" })).resolves.toMatchObject({ invoiceStatus: "created" });
    expect(mocks.createOrder).toHaveBeenCalledOnce();
  });

  it("requires manual review when the invoice stays missing after the window", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [], complete: true });
    await expect(syncShopifyOrder(invoiceOrder())).rejects.toBeInstanceOf(RetryableError);
    mocks.db.invoices.get("5001")!.claimed_at = new Date(Date.now() - 10 * 60_000);
    await expect(syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" })).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "needs_review" });
  });

  it("requires manual review when KiotViet shows two invoices for the order", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [
      { id: 9001, code: "HD9001", orderCode: "DH700", status: 1 }, { id: 9002, code: "HD9002", orderCode: "DH700", status: 1 },
    ], complete: true });
    await expect(syncShopifyOrder(invoiceOrder())).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "needs_review", kiotviet_invoice_id: null });
  });

  it("flags an invoice whose total does not match instead of trusting it", async () => {
    mocks.invoiceDetail.mockResolvedValue({ id: 9001, code: "HD9001", orderCode: "DH700", status: 1, total: 290000, totalPayment: 290000 });
    await expect(syncShopifyOrder(invoiceOrder())).resolves.toMatchObject({ invoiceStatus: "needs_review" });
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "9001" });
  });

  it("does not invoice and marks the invoice failed when SKU mapping fails", async () => {
    mocks.ensureMapping.mockRejectedValue(new MappingError("Cannot auto-map SKU NU012", { mappingStatus: "unmapped" }));
    await expect(syncShopifyOrder(invoiceOrder())).rejects.toBeInstanceOf(MappingError);
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "failed" });
  });

  it("excludes the SVC fee from the invoice and never deducts stock for it", async () => {
    await syncShopifyOrder(invoiceOrder({ total_price: "309000", line_items: [...order().line_items, fee] }));
    const input = mocks.createOrder.mock.calls[0][0];
    expect(input).toMatchObject({ makeInvoice: true, totalPayment: 300000 });
    expect(input.orderDetails).toHaveLength(1);
    expect(mocks.db.invoices.get("5001")).toMatchObject({ expected_total: "300000", status: "created" });
    expect(stock["501"]).toBe(8);
  });

  it.each([
    ["the KiotViet currency is not configured", {}, { kiotVietCurrency: undefined }, "kiotviet_currency_not_configured"],
    ["the order is in another currency", { currency: "USD" }, {}, "currency_mismatch"],
    ["a product line is discounted", { total_price: "290000", line_items: [{ id: 11, sku: "NU012", quantity: 2, price: "150000", name: "A", discount_allocations: [{ amount: "10000" }] }] }, {}, "unsupported_discount"],
    ["the order has shipping", { total_price: "330000", shipping_lines: [{ price: "30000" }] }, {}, "unsupported_shipping"],
    ["totals do not reconcile", { total_price: "310000" }, {}, "amount_mismatch"],
    ["products were partially refunded", { financial_status: "partially_refunded", refunds: [{ id: 1, refund_line_items: [{ line_item_id: 11, quantity: 1 }], transactions: [{ kind: "refund", status: "success", amount: "150000" }] }] }, {}, "refund_affects_products"],
  ])("creates the order without an invoice when %s", async (_label, orderOverrides, settingOverrides, code) => {
    mocks.db.orders = { ...mocks.db.orders, ...settingOverrides, paidOnly: false };
    await expect(syncShopifyOrder(invoiceOrder(orderOverrides as Partial<ShopifyOrderWebhook>))).resolves.toMatchObject({ action: "created" });
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ makeInvoice: false }));
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "blocked", last_error: expect.stringContaining(code) });
    expect(stock["501"]).toBe(10);
  });

  it("invoices a partially refunded order when only the processing fee was refunded", async () => {
    // paidOnly (unchanged) only creates orders whose status is exactly "paid".
    mocks.db.orders.paidOnly = false;
    await syncShopifyOrder(invoiceOrder({
      financial_status: "partially_refunded", total_price: "309000", line_items: [...order().line_items, fee],
      refunds: [{ id: 1, refund_line_items: [{ line_item_id: 15977877143736, quantity: 1 }], transactions: [{ kind: "refund", status: "success", amount: "9000" }] }],
    }));
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ makeInvoice: true }));
  });

  it("never creates or invoices a cancelled order", async () => {
    await expect(syncShopifyOrder(invoiceOrder({ cancelled_at: "2026-11-01T00:00:00Z" }))).resolves.toMatchObject({ action: "skipped" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("creates the order without invoice when the branch has no Shopify location mapping", async () => {
    mocks.db.locationMapped = false;
    await syncShopifyOrder(invoiceOrder());
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ makeInvoice: false }));
    expect(mocks.db.invoices.get("5001")).toMatchObject({ status: "blocked", last_error: expect.stringContaining("branch_location_unmapped") });
  });

  it("creates one order and one invoice for concurrent webhooks", async () => {
    const results = await Promise.allSettled([
      syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_create" }),
      syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" }),
      syncShopifyOrder(invoiceOrder(), { jobType: "shopify_order_update" }),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(mocks.createOrder).toHaveBeenCalledOnce();
    expect(stock["501"]).toBe(8);
    expect(mocks.db.invoices.get("5001")).toMatchObject({ kiotviet_invoice_id: "9001" });
  });
});
