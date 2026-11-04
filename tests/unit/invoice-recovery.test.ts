vi.mock("@/lib/shopify/invoice-order", () => ({ getInvoiceOrder: async () => structuredClone(mocks.event?.payload) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyOrderWebhook } from "@/types/shopify";

const ORDER_ID = "7108106289336";
const mocks = vi.hoisted(() => ({
  invoice: undefined as Record<string, unknown> | undefined,
  orderSettings: {} as Record<string, unknown>,
  event: undefined as { id: string; payload: unknown } | undefined,
  locationMapped: true,
  sql: [] as string[],
  transactions: 0,
  stock: {} as Record<string, number>,
  kiotVietOrder: vi.fn(),
  live: vi.fn(),
  findInvoices: vi.fn(),
  createInvoice: vi.fn(),
  invoiceDetail: vi.fn(),
  findBySku: vi.fn(),
}));

function run(sql: string, params: unknown[]): Record<string, unknown>[] {
  mocks.sql.push(sql);
  const now = () => new Date(Date.now() + mocks.sql.length).toISOString();
  if (sql.includes("pg_advisory_xact_lock")) return [];
  if (sql.includes("FROM order_mappings"))
    return [{ shopify_order_id: ORDER_ID, shopify_order_number: "#1072", kiotviet_order_id: "5555", kiotviet_order_code: "DH1072", status: "created" }];
  if (sql.includes("FROM system_settings")) return [{ value: mocks.orderSettings }];
  if (sql.includes("FROM webhook_events")) return mocks.event ? [mocks.event] : [];
  if (sql.includes("FROM branch_location_mappings")) return mocks.locationMapped ? [{}] : [];
  if (sql.startsWith("SELECT") && sql.includes("FROM invoice_mappings")) return mocks.invoice ? [{ ...mocks.invoice }] : [];
  const row = mocks.invoice;
  if (sql.startsWith("INSERT INTO invoice_mappings")) {
    if (row) {
      const allowed = !row.kiotviet_invoice_id && params[8] !== null && row.updated_at === params[8] &&
        (["failed", "blocked"].includes(String(row.status)) || params[3] === "linked");
      if (!allowed) return [];
    }
    mocks.invoice = {
      ...(row ?? { kiotviet_invoice_id: null, created_at: new Date() }), shopify_order_id: ORDER_ID,
      kiotviet_order_id: String(params[1]), kiotviet_order_code: params[2], status: "pending", source: params[3],
      claim_token: params[4], claimed_at: new Date(), expected_total: String(params[5]), currency: params[6],
      reconciliation: JSON.parse(String(params[7])), updated_at: now(),
    };
    return [{ ...mocks.invoice }];
  }
  if (!row) return [];
  if (sql.startsWith("UPDATE invoice_mappings SET status='creating'")) {
    if (row.status !== "pending" || row.claim_token !== params[1]) return [];
    Object.assign(row, { status: "creating", reconciliation: JSON.parse(String(params[2])), updated_at: now() });
    return [{}];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status='failed'") && sql.includes("manual_reset")) {
    if (row.kiotviet_invoice_id || row.updated_at !== params[1]) return [];
    Object.assign(row, { status: "failed", updated_at: now() });
    return [{}];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status='failed'")) {
    if (row.claim_token === params[1]) Object.assign(row, { status: "failed", updated_at: now() });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET last_error")) { Object.assign(row, { last_error: params[2], updated_at: now() }); return []; }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_invoice_id=$2")) {
    if (row.kiotviet_invoice_id) return [];
    Object.assign(row, { kiotviet_invoice_id: String(params[1]), kiotviet_invoice_code: params[2], status: params[3], reconciliation: JSON.parse(String(params[4])), updated_at: now() });
    return [{}];
  }
  throw new Error(`Unhandled SQL: ${sql.slice(0, 70)}`);
}

vi.mock("@/lib/db/client", () => {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    query: async (sql: string, params: unknown[] = []) => run(sql, params),
    transaction: (callback: (client: unknown) => Promise<unknown>) => {
      mocks.transactions++;
      const result = chain.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return callback({ query: async (sql: string, params: unknown[] = []) => ({ rows: run(sql, params) }) });
      });
      chain = result.catch(() => undefined);
      return result;
    },
  };
});
vi.mock("@/lib/kiotviet/orders", () => ({ getKiotVietOrder: mocks.kiotVietOrder }));
vi.mock("@/lib/shopify/orders", () => ({ getShopifyOrderPaymentState: mocks.live }));
vi.mock("@/lib/kiotviet/invoices", () => ({
  findKiotVietInvoicesForOrder: mocks.findInvoices,
  createKiotVietInvoice: mocks.createInvoice,
  getKiotVietInvoiceDetail: mocks.invoiceDetail,
  KIOTVIET_INVOICE_CANCELLED: 2,
}));
vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietProduct: async (id: number) => ({ id, inventories: [{ branchId: 10, onHand: mocks.stock[String(id)] }] }),
}));
vi.mock("@/repositories/mappings", () => ({ mappingsRepository: { findBySku: mocks.findBySku } }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));

import {
  applyInvoiceRecovery,
  describeInvoiceRecoveryPlan,
  parseInvoiceRecoveryArgs,
  planInvoiceRecovery,
} from "@/lib/recovery/kiotviet-invoice-recovery";
import { RecoveryArgsError } from "@/lib/recovery/shopify-order-recovery";
import { ApiError, UncertainResultError } from "@/lib/errors";

// #1072: SKUs 377, 711, 1045, 1030 × 1; total 93.33 incl. SVC fee 3.33 → 90.00.
const products = [
  { sku: "377", productId: 377001, price: "20.00" },
  { sku: "711", productId: 711001, price: "25.00" },
  { sku: "1045", productId: 1045001, price: "30.00" },
  { sku: "1030", productId: 1030001, price: "15.00" },
];
const order1072 = (overrides: Partial<ShopifyOrderWebhook> = {}): ShopifyOrderWebhook => ({
  id: 7108106289336, name: "#1072", financial_status: "paid", currency: "USD", total_price: "93.33", refunds: [],
  line_items: [
    ...products.map((product, index) => ({ id: 100 + index, sku: product.sku, quantity: 1, price: product.price, title: `Product ${product.sku}` })),
    { id: 999, sku: null, quantity: 1, price: "3.33", title: "SVC Fee - Credit Card Processing Fee" },
  ],
  ...overrides,
});
const kiotVietOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 5555, code: "DH1072", branchId: 10, status: 1, total: 90, totalPayment: 90, customerId: 77,
  createdDate: "2026-10-30T00:00:00Z",
  orderDetails: products.map((product) => ({ productId: product.productId, productCode: product.sku, productName: product.sku, quantity: 1, price: Number(product.price), discount: 0 })),
  ...overrides,
});
const noInvoices = { invoices: [], complete: true };

it("retains the invoice ID but requires review when inventory did not move", async () => {
  mocks.createInvoice.mockResolvedValue({ id: 8001, code: "HD8001" });
  await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
  expect(mocks.invoice).toMatchObject({ kiotviet_invoice_id: "8001", status: "needs_review",
    reconciliation: expect.objectContaining({ stockVerified: false }) });
  await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
  expect(mocks.createInvoice).toHaveBeenCalledOnce();
});

it("blocks the reported 80 product / 90 prepaid discrepancy", async () => {
  const snapshot = order1072();
  snapshot.line_items[0].price = "10.00";
  mocks.event = { id: "e", payload: snapshot };
  const remote = kiotVietOrder({ total: 80 });
  remote.orderDetails[0].price = 10;
  mocks.kiotVietOrder.mockResolvedValue(remote);
  const plan = await planInvoiceRecovery(ORDER_ID);
  expect(plan.action).toMatchObject({ kind: "blocked", reasons: expect.arrayContaining([
    expect.stringContaining("amount_mismatch"), expect.stringContaining("overpaid"),
  ]) });
  expect(mocks.createInvoice).not.toHaveBeenCalled();
});

it("does not send an invoice if the live order changes after planning", async () => {
  const plan = await planInvoiceRecovery(ORDER_ID);
  mocks.event = { id: "new", payload: order1072({ cancelled_at: "2026-11-04" }) };
  await expect(applyInvoiceRecovery(plan)).resolves.toMatchObject({ applied: false, message: expect.stringContaining("Order changed") });
  expect(mocks.createInvoice).not.toHaveBeenCalled();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoice = undefined;
  mocks.orderSettings = { defaultBranchId: 10, kiotVietCurrency: "USD" };
  mocks.event = { id: "event-1072", payload: order1072() };
  mocks.locationMapped = true;
  mocks.sql = [];
  mocks.transactions = 0;
  for (const product of products) mocks.stock[String(product.productId)] = 5;
  mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder());
  mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "93.33" } }, refunds: [] });
  mocks.findInvoices.mockResolvedValue(noInvoices);
  mocks.findBySku.mockImplementation(async (sku: string) => {
    const product = products.find((item) => item.sku === sku);
    return product ? [{ kiotviet_product_id: String(product.productId), sync_status: "mapped" }] : [];
  });
  mocks.createInvoice.mockImplementation(async () => {
    for (const product of products) mocks.stock[String(product.productId)] -= 1;
    return { id: 8001, code: "HD8001" };
  });
  mocks.invoiceDetail.mockResolvedValue({ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1, branchId: 10, invoiceDetails: kiotVietOrder().orderDetails, total: 90, totalPayment: 0 });
});

describe("invoice recovery CLI arguments", () => {
  it("parses the documented commands", () => {
    expect(parseInvoiceRecoveryArgs(["--list"])).toEqual({ mode: "list" });
    expect(parseInvoiceRecoveryArgs([ORDER_ID])).toEqual({ mode: "recover", shopifyOrderIds: [ORDER_ID], apply: false, resetUncertain: false });
    expect(parseInvoiceRecoveryArgs([ORDER_ID, "--apply"])).toMatchObject({ apply: true });
  });
  it.each([[[]], [["#1072"]], [["--list", ORDER_ID]], [["--force"]], [["1", "2", "--reset-uncertain"]]])("rejects %j", (argv) => {
    expect(() => parseInvoiceRecoveryArgs(argv)).toThrow(RecoveryArgsError);
  });
});

describe("existing order #1072 without invoice", () => {
  it("plans one invoice against the existing KiotViet order without recording payment twice", async () => {
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({
      kind: "create_invoice",
      input: { branchId: 10, orderId: 5555, customerId: 77, discount: 0, totalPayment: 0, invoiceDetails: expect.arrayContaining([expect.objectContaining({ productId: 377001, quantity: 1, price: 20 })]) },
    });
    expect(plan.expectedTotal).toBe(90);
    const output = describeInvoiceRecoveryPlan(plan).join("\n");
    expect(output).toContain("excluded fee: line 999");
    expect(output).toContain("shopify_total=93.33 excluded_fees=3.33 expected_invoice_total=90 currency=USD");
    expect(output).toContain("additional payment 0");
  });

  it("dry run is strictly read-only", async () => {
    await planInvoiceRecovery(ORDER_ID);
    expect(mocks.sql.every((sql) => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(mocks.transactions).toBe(0);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("creates the invoice once, saves it and verifies the stock movement", async () => {
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
    expect(result).toMatchObject({ applied: true, message: expect.stringContaining("HD8001: created; stock verified") });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.invoice).toMatchObject({
      status: "created", source: "recovery", kiotviet_order_id: "5555", kiotviet_invoice_id: "8001",
      reconciliation: expect.objectContaining({ stockBefore: expect.objectContaining({ 377001: 5 }), stockAfter: expect.objectContaining({ 377001: 4 }), stockVerified: true }),
    });
  });

  it("links an invoice that already exists instead of issuing another", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1 }], complete: true });
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action).toEqual({ kind: "link", invoice: { id: 8001, code: "HD8001" } });
    await applyInvoiceRecovery(plan);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
    expect(mocks.invoice).toMatchObject({ status: "needs_review", source: "linked", kiotviet_invoice_id: "8001" });
  });

  it("does nothing once the invoice is recorded", async () => {
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
    expect((await planInvoiceRecovery(ORDER_ID)).action.kind).toBe("none");
  });

  it("issues at most one invoice when two operators apply concurrently", async () => {
    const [first, second] = await Promise.all([planInvoiceRecovery(ORDER_ID), planInvoiceRecovery(ORDER_ID)]);
    const results = await Promise.all([applyInvoiceRecovery(first), applyInvoiceRecovery(second)]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("does not resend after a timeout and links the invoice KiotViet created", async () => {
    mocks.createInvoice.mockImplementationOnce(async () => { throw new UncertainResultError("timeout"); });
    await expect(applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID))).resolves.toMatchObject({ applied: false, message: expect.stringContaining("NOT resent") });
    expect(mocks.invoice).toMatchObject({ status: "creating" });
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("invoice_in_flight")] });

    mocks.invoice!.claimed_at = new Date(Date.now() - 10 * 60_000);
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("invoice_outcome_unknown")] });

    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1 }], complete: true });
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "8001" });
  });

  it("lets an operator reset a confirmed-missing uncertain attempt, then invoice", async () => {
    mocks.createInvoice.mockImplementationOnce(async () => { throw new UncertainResultError("timeout"); });
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
    mocks.invoice!.claimed_at = new Date(Date.now() - 10 * 60_000);
    const reset = await planInvoiceRecovery(ORDER_ID, { resetUncertain: true });
    expect(reset.action.kind).toBe("reset_uncertain");
    await applyInvoiceRecovery(reset);
    expect(mocks.invoice).toMatchObject({ status: "failed" });
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
    expect(mocks.invoice).toMatchObject({ status: "created" });
  });

  it("marks a rejected invoice as failed so it can be planned again", async () => {
    mocks.createInvoice.mockRejectedValueOnce(new ApiError("KiotViet API error (400): insufficient stock", 400));
    await expect(applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID))).resolves.toMatchObject({ applied: false });
    expect(mocks.invoice).toMatchObject({ status: "failed" });
  });

  it("links an invoice that appeared between the dry run and apply", async () => {
    const plan = await planInvoiceRecovery(ORDER_ID);
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1 }], complete: true });
    await expect(applyInvoiceRecovery(plan)).resolves.toMatchObject({ message: expect.stringContaining("appeared since the dry run") });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["the currency differs", () => { mocks.orderSettings.kiotVietCurrency = "VND"; }, "currency_mismatch"],
    ["the stored payload is stale", () => mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "93.33" } }, refunds: [{ id: "r" }] }), "stale_payload"],
    ["the KiotViet order is in another branch", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ branchId: 11 })), "branch_mismatch"],
    ["the branch has no Shopify location", () => { mocks.locationMapped = false; }, "branch_location_unmapped"],
    ["a KiotViet quantity differs", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ orderDetails: [...kiotVietOrder().orderDetails.slice(1), { ...kiotVietOrder().orderDetails[0], quantity: 2 }] })), "quantity_mismatch"],
    ["a KiotViet price differs", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ orderDetails: [...kiotVietOrder().orderDetails.slice(1), { ...kiotVietOrder().orderDetails[0], price: 21 }] })), "price_mismatch"],
    ["the KiotViet order is cancelled", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ status: 4 })), "kiotviet_order_cancelled"],
    ["the order total does not reconcile", () => { mocks.event = { id: "e", payload: order1072({ total_price: "95.00" }) }; mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "95.00" } }, refunds: [] }); }, "amount_mismatch"],
    ["a product was refunded", () => {
      mocks.event = { id: "e", payload: order1072({ financial_status: "partially_refunded", refunds: [{ id: 1, refund_line_items: [{ line_item_id: 100, quantity: 1 }], transactions: [{ kind: "refund", status: "success", amount: "20.00" }] }] }) };
      mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "93.33" } }, refunds: [{ id: "1" }] });
    }, "refund_affects_products"],
    ["the order is overpaid in KiotViet", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ totalPayment: 93.33 })), "overpaid"],
  ])("blocks invoicing when %s", async (_label, setup, code) => {
    setup();
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "blocked", reasons: expect.arrayContaining([expect.stringContaining(code)]) });
    await expect(applyInvoiceRecovery(plan)).resolves.toMatchObject({ applied: false });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("blocks when two invoices already exist or the lookup is incomplete", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 1, code: "HD1", orderCode: "DH1072", status: 1 }, { id: 2, code: "HD2", orderCode: "DH1072", status: 1 }], complete: true });
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("duplicate_invoices")] });
    mocks.findInvoices.mockResolvedValue({ invoices: [], complete: false });
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("invoice_lookup_incomplete")] });
  });
});
