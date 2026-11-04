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
  db: {
    rows: new Map<string, Row>(),
    orders: {} as Record<string, unknown>,
    customers: new Map<string, string>(),
  },
}));

/** Minimal order_mappings store that honors the WHERE guards order-sync relies on. */
function run(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const { db } = mocks;
  const id = String(params[0]);
  const row = db.rows.get(id);
  const now = new Date();
  if (sql.includes("pg_advisory_xact_lock")) return [];
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
