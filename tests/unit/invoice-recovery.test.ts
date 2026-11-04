vi.mock("@/lib/shopify/invoice-order", () => ({ getInvoiceOrder: async () => structuredClone(mocks.event?.payload) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyOrderWebhook } from "@/types/shopify";

const ORDER_ID = "7108106289336";
const mocks = vi.hoisted(() => ({
  orderMapping: {} as Record<string, unknown>,
  evidence: undefined as Record<string, unknown> | undefined,
  audit: [] as Array<{ actor: unknown; action: unknown; entityId: unknown; before: Record<string, unknown>; after: Record<string, unknown> | null }>,
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
  if (sql.startsWith("INSERT INTO audit_logs")) { mocks.audit.push({ actor: params[0], action: params[1], entityId: params[2], before: JSON.parse(String(params[3])), after: JSON.parse(String(params[4])) }); return []; }
  if (sql.includes("FROM order_mappings"))
    return [{ shopify_order_id: ORDER_ID, shopify_order_number: "#1072", kiotviet_order_id: "5555", kiotviet_order_code: "DH1072", status: "created", ...mocks.orderMapping }];
  if (sql.includes("FROM system_settings"))
    return params[0] === "kiotviet_prepayment_evidence" ? (mocks.evidence ? [{ value: mocks.evidence }] : []) : [{ value: mocks.orderSettings }];
  if (sql.includes("FROM webhook_events")) return mocks.event ? [mocks.event] : [];
  if (sql.includes("FROM branch_location_mappings")) return mocks.locationMapped ? [{}] : [];
  if (sql.startsWith("SELECT") && sql.includes("FROM invoice_mappings")) return mocks.invoice ? [{ ...mocks.invoice }] : [];
  const row = mocks.invoice;
  if (sql.startsWith("INSERT INTO invoice_mappings")) {
    if (row) {
      const stalePending = row.status === "pending" && Date.parse(String(row.claimed_at)) < Date.now() - 5 * 60_000;
      const allowed = !row.kiotviet_invoice_id && params[8] !== null && row.updated_at === params[8] &&
        (["failed", "blocked"].includes(String(row.status)) || params[3] === "linked" || stalePending);
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
  if (sql.startsWith("UPDATE invoice_mappings SET status=$4")) {
    if (row.claim_token !== params[1] || row.status !== "pending") return [];
    Object.assign(row, { status: params[3], claim_token: null, last_error: params[2], failure_stage: params[4], updated_at: now() });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET last_error")) { Object.assign(row, { last_error: params[2], updated_at: now() }); return []; }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_invoice_id=$3")) {
    if (row.claim_token !== params[1]) return [];
    Object.assign(row, { kiotviet_invoice_id: String(params[2]), kiotviet_invoice_code: params[3], status: "needs_review", updated_at: now() });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_invoice_id=$2")) {
    if (row.kiotviet_invoice_id && row.kiotviet_invoice_id !== String(params[1])) return [];
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
vi.mock("@/lib/env", () => ({ getEnv: () => ({ SESSION_SECRET: "test-session-secret-0123456789abcdef" }) }));

import {
  applyInvoiceRecovery,
  describeInvoiceRecoveryPlan,
  parseInvoiceRecoveryArgs,
  planInvoiceRecovery,
} from "@/lib/recovery/kiotviet-invoice-recovery";
import { RecoveryArgsError } from "@/lib/recovery/shopify-order-recovery";
import { ApiError, ConflictError, UncertainResultError } from "@/lib/errors";
import { previewInvoiceOverride, submitInvoiceOverride } from "@/lib/recovery/invoice-override";

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
const carriedEvidence = {
  retailer: "sandbox-shop", testedAt: "2026-11-04T08:00:00.000Z",
  order: { id: 1, code: "DH-TEST", total: 100, prepaid: 100 },
  invoice: { id: 2, code: "HD-TEST", requestedTotalPayment: 0, total: 100, totalPayment: 100, paymentRows: [{ amount: 100 }] },
  orderAfter: { status: 3, totalPayment: 100 }, result: "carried",
};

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
  await expect(applyInvoiceRecovery(plan)).resolves.toMatchObject({ applied: false, message: expect.stringContaining("order changed during validation") });
  // Nothing was sent, so the claim is released as safely retryable, not left pending.
  expect(mocks.invoice).toMatchObject({ status: "failed", claim_token: null });
  expect(mocks.createInvoice).not.toHaveBeenCalled();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoice = undefined;
  mocks.orderSettings = { defaultBranchId: 10, kiotVietCurrency: "USD" };
  mocks.event = { id: "event-1072", payload: order1072() };
  mocks.locationMapped = true;
  mocks.sql = [];
  mocks.audit = [];
  mocks.orderMapping = {};
  // Sandbox evidence that invoices inherit the order prepayment, plus accounting sign-off.
  mocks.evidence = carriedEvidence;
  mocks.orderSettings.invoicePrepaymentVerified = true;
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
  // "Khách đã trả" includes the inherited prepayment (as the sandbox evidence shows).
  mocks.invoiceDetail.mockResolvedValue({ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1, branchId: 10, invoiceDetails: kiotVietOrder().orderDetails, total: 90, totalPayment: 90, payments: [{ amount: 90, method: "Transfer" }] });
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

describe("shipping via KiotViet surcharge and existing prepayments", () => {
  const surcharge = { id: 3, code: "SHIP", invoiceInheritsFromOrder: true };
  const withShipping = () => {
    mocks.event = { id: "e", payload: order1072({ total_price: "103.33", shipping_lines: [{ price: "12.00", discounted_price: "10.00" }] }) };
    mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "103.33" } }, refunds: [] });
  };
  const blockedWith = async (code: string) => {
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "blocked", reasons: expect.arrayContaining([expect.stringContaining(code)]) });
    return plan;
  };

  it("blocks shipping when no KiotViet surcharge is configured (never added to product prices)", async () => {
    withShipping();
    await blockedWith("unsupported_shipping");
  });

  it("blocks shipping until the operator confirmed invoices keep the order surcharge", async () => {
    withShipping();
    mocks.orderSettings.shippingSurcharge = { id: 3, code: "SHIP" };
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 100, totalPayment: 100, invoiceOrderSurcharges: [{ surchargeId: 3, price: 10 }] }));
    await blockedWith("shipping_unverified");
  });

  it("invoices product lines plus the shipping surcharge without recording the prepayment twice", async () => {
    withShipping();
    mocks.orderSettings.shippingSurcharge = surcharge;
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 100, totalPayment: 100, invoiceOrderSurcharges: [{ surchargeId: 3, price: 10 }] }));
    mocks.invoiceDetail.mockResolvedValue({ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1, branchId: 10, invoiceDetails: kiotVietOrder().orderDetails, total: 100, totalPayment: 100, payments: [{ amount: 100 }], invoiceOrderSurcharges: [{ surchargeId: 3, price: 10 }] });
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.expectedTotal).toBe(100);
    expect(plan.action).toMatchObject({ kind: "create_invoice", input: { totalPayment: 0 } });
    // Product prices are untouched; shipping is not an invoice line.
    expect((plan.action as { input: { invoiceDetails: Array<{ price: number }> } }).input.invoiceDetails.map((detail) => detail.price)).toEqual([20, 25, 30, 15]);
    await applyInvoiceRecovery(plan);
    expect(mocks.invoice).toMatchObject({ status: "created", reconciliation: expect.objectContaining({ shippingTotal: 10 }) });
  });

  it("accepts a KiotViet order total that excludes the verified surcharge", async () => {
    withShipping();
    mocks.orderSettings.shippingSurcharge = surcharge;
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 90, totalPayment: 100, invoiceOrderSurcharges: [{ surchargeId: 3, price: 10 }] }));
    expect((await planInvoiceRecovery(ORDER_ID)).action.kind).toBe("create_invoice");
  });

  it("blocks orders whose KiotViet order was created without the shipping surcharge", async () => {
    withShipping();
    mocks.orderSettings.shippingSurcharge = surcharge;
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 90, totalPayment: 100 }));
    await blockedWith("shipping_not_on_kiotviet_order");
  });

  it("blocks a surcharge amount or extra surcharge that does not match Shopify shipping", async () => {
    withShipping();
    mocks.orderSettings.shippingSurcharge = surcharge;
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 102, totalPayment: 100, invoiceOrderSurcharges: [{ surchargeId: 3, price: 12 }] }));
    await blockedWith("shipping_mismatch");
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 100, invoiceOrderSurcharges: [{ surchargeId: 9, surchargeName: "Gift wrap", price: 10 }] }));
    await blockedWith("unexpected_surcharge");
  });

  it.each([
    [90, 0],
    [40, 50],
    [0, 90],
  ])("records only the unpaid remainder when KiotViet already has %s prepaid", async (prepaid, payment) => {
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ totalPayment: prepaid }));
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "create_invoice", input: { totalPayment: payment } });
  });

  it("blocks when KiotViet payment rows disagree with totalPayment", async () => {
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ totalPayment: 90, payments: [{ amount: 50 }] }));
    await blockedWith("payment_mismatch");
  });

  it("blocks when the KiotViet currency is not configured", async () => {
    delete mocks.orderSettings.kiotVietCurrency;
    await blockedWith("kiotviet_currency_not_configured");
  });
});

describe("admin invoice override (Bỏ qua cảnh báo & tạo hóa đơn)", () => {
  // #1072 variant: Shopify charged 10 shipping that was never recorded on the KiotViet order.
  const shippedOrder = () => {
    mocks.event = { id: "e", payload: order1072({ total_price: "103.33", shipping_lines: [{ price: "10.00", discounted_price: "10.00" }] }) };
    mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "103.33" } }, refunds: [] });
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 90, totalPayment: 100 }));
  };
  const codes = ["shipping_not_on_kiotviet_order", "total_mismatch", "unsupported_shipping"];
  const submit = (token: string, overrides: Partial<Parameters<typeof submitInvoiceOverride>[0]> = {}) =>
    submitInvoiceOverride({ orderId: ORDER_ID, admin: "admin", previewToken: token, bypassPlanBlocked: true, approvedWarnings: codes, confirm: true, reason: "Khách đã trả phí ship trên Shopify; kế toán đồng ý", ...overrides });

  beforeEach(() => {
    shippedOrder();
    mocks.orderSettings.invoicePrepaymentVerified = true;
  });

  it("previews the exact invoice, amounts and every overridable warning (read-only)", async () => {
    const { preview, previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(preview).toMatchObject({
      shopifyOrderId: ORDER_ID, kiotVietOrder: { id: 5555, code: "DH1072" }, submitAllowed: true, blockers: [],
      amounts: {
        currency: "USD",
        shopify: { merchandise: 90, shipping: 10, excludedFees: 3.33, total: 103.33, paidForGoods: 100 },
        invoice: { merchandise: 90, surcharges: 0, total: 90 },
        payment: { existingPrepayment: 100, additionalPayment: 0, totalRecorded: 100, overpayment: 10, remainingBalance: 0 },
      },
      reconciled: false,
      payload: { orderId: 5555, branchId: 10, totalPayment: 0, discount: 0 },
    });
    // Differences that remain after invoicing are shown explicitly.
    expect(preview.remainingDifferences).toEqual([
      expect.objectContaining({ code: "shipping_unrecorded", amount: 10 }),
      expect.objectContaining({ code: "overpayment", amount: 10 }),
    ]);
    expect(preview.warnings.map((warning) => warning.code).sort()).toEqual(codes);
    // Product prices untouched, no invented shipping line or surcharge.
    expect(preview.lines.map((line) => [line.productCode, line.quantity, line.price])).toEqual([["377", 1, 20], ["711", 1, 25], ["1045", 1, 30], ["1030", 1, 15]]);
    expect(JSON.stringify(preview.payload)).not.toMatch(/surchag|deliveryDetail/);
    expect(previewToken).toMatch(/\./);
    expect(mocks.sql.every((sql) => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("creates exactly the previewed invoice for an authorized, confirmed and justified override, and audits it", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    // KiotViet reports the inherited 100 as paid on the 90 invoice.
    mocks.invoiceDetail.mockResolvedValue({ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1, branchId: 10, invoiceDetails: kiotVietOrder().orderDetails, total: 90, totalPayment: 100, payments: [{ amount: 100 }] });
    const result = await submit(previewToken);
    // Created and linked, but never labelled reconciled while shipping/payment differences remain.
    expect(result).toMatchObject({ applied: true, invoiceCode: "HD8001", status: "needs_review" });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.createInvoice.mock.calls[0][0]).toMatchObject({ orderId: 5555, totalPayment: 0 });
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "8001", expected_total: "90",
      reconciliation: expect.objectContaining({
        approvedWarnings: codes, manualOverride: expect.objectContaining({ admin: "admin", approvedWarnings: codes }),
        remainingDifferences: [expect.objectContaining({ code: "shipping_unrecorded" }), expect.objectContaining({ code: "overpayment" })],
        checks: expect.objectContaining({ financialValidation: true, payment: true, financiallyReconciled: false }),
      }) });
    expect(mocks.audit.map((entry) => entry.action)).toEqual(["kiotviet_invoice_override_requested", "kiotviet_invoice_override_result"]);
    expect(mocks.audit[0]).toMatchObject({ actor: "admin", entityId: ORDER_ID,
      before: expect.objectContaining({ reason: expect.stringContaining("kế toán"), approvedWarnings: codes, payloadSummary: expect.objectContaining({ invoiceTotal: 90, additionalPayment: 0 }) }) });
    expect(mocks.audit[1].after).toMatchObject({ applied: true });
  });

  it("keeps automatic invoicing strict for the same order", async () => {
    expect((await planInvoiceRecovery(ORDER_ID)).action.kind).toBe("blocked");
  });

  it.each([
    ["accounting has not signed off", () => { mocks.orderSettings.invoicePrepaymentVerified = false; }],
    ["no sandbox evidence exists", () => { mocks.evidence = undefined; }],
    ["the sandbox showed the prepayment is not carried", () => { mocks.evidence = { ...carriedEvidence, result: "not_carried" }; }],
  ])("keeps automatic invoicing blocked but allows the manual exception (no added payment) when %s", async (_label, setup) => {
    setup();
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: expect.arrayContaining([expect.stringContaining("prepayment_inheritance_unverified")]) });
    const { preview } = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(preview).toMatchObject({ planStatus: "blocked", submitAllowed: true, payload: { totalPayment: 0 }, reconciled: false });
    expect(preview.warnings.map((warning) => warning.code)).toContain("prepayment_inheritance_unverified");
    expect(preview.remainingDifferences.map((item) => item.code)).toContain("prepayment_inheritance_unverified");
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it.each([
    [{ approvedWarnings: ["total_mismatch"] }, "Approve exactly"],
    [{ approvedWarnings: [...codes, "currency_mismatch"] }, "Approve exactly"],
    [{ confirm: false }, "Confirm"],
    [{ reason: "ok" }, "reason"],
    [{ admin: "someone-else" }, "another order or administrator"],
    [{ previewToken: "forged.token" }, "invalid"],
  ])("rejects %j without sending anything", async (overrides, message) => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submit(previewToken, overrides as never)).rejects.toThrow(message);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
    expect(mocks.audit).toEqual([]);
  });

  it("rejects an expired preview", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
    try {
      await expect(submit(previewToken)).rejects.toThrow("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the KiotViet order changed after the preview", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 90, totalPayment: 60 }));
    await expect(submit(previewToken)).rejects.toThrow("changed since the preview");
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("never overrides an existing active invoice or duplicate invoices", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1 }], complete: true });
    const single = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(single.preview).toMatchObject({ submitAllowed: false, blockers: [expect.objectContaining({ code: "existing_active_invoice" })] });
    await expect(submit(single.previewToken)).rejects.toBeInstanceOf(ConflictError);
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 1, code: "HD1", orderCode: "DH1072", status: 1 }, { id: 2, code: "HD2", orderCode: "DH1072", status: 1 }], complete: true });
    const duplicate = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(duplicate.preview.blockers.map((item) => item.code)).toContain("duplicate_invoices");
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("never overrides an incomplete invoice index", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [], complete: false, indexError: "index not current" });
    const { preview, previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(preview).toMatchObject({ submitAllowed: false, payload: null });
    expect(preview.blockers.map((item) => item.code)).toContain("invoice_lookup_incomplete");
    await expect(submit(previewToken)).rejects.toBeInstanceOf(ConflictError);
  });

  it.each([
    ["currency mismatch", () => { mocks.orderSettings.kiotVietCurrency = "VND"; }, "currency_mismatch"],
    ["quantity mismatch", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 110, totalPayment: 100, orderDetails: [...kiotVietOrder().orderDetails.slice(1), { ...kiotVietOrder().orderDetails[0], quantity: 2 }] })), "quantity_mismatch"],
    ["stale order state", () => mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "103.33" } }, refunds: [{ id: "r" }] }), "stale_payload"],
    ["cancelled KiotViet order", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({ total: 90, totalPayment: 100, status: 4 })), "kiotviet_order_cancelled"],
  ])("never overrides %s", async (_label, setup, code) => {
    setup();
    const { preview, previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(preview.submitAllowed).toBe(false);
    expect(preview.blockers.map((item) => item.code)).toContain(code);
    await expect(submit(previewToken, { approvedWarnings: preview.warnings.map((warning) => warning.code) })).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("creates at most one invoice for concurrent submissions of the same preview", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    const results = await Promise.allSettled([submit(previewToken), submit(previewToken), submit(previewToken)]);
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(results.filter((result) => result.status === "fulfilled" && result.value.applied)).toHaveLength(1);
  });

  it("keeps an uncertain state after a timeout and never resends", async () => {
    mocks.createInvoice.mockImplementationOnce(async () => { throw new UncertainResultError("timeout"); });
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submit(previewToken)).resolves.toMatchObject({ applied: false, message: expect.stringContaining("NOT resent") });
    expect(mocks.invoice).toMatchObject({ status: "creating" });
    expect(mocks.audit[1].after).toMatchObject({ applied: false });
    // The same preview can no longer be used, and a new one is blocked while the outcome is unknown.
    await expect(submit(previewToken)).rejects.toBeInstanceOf(ConflictError);
    const again = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(again.preview.blockers.map((item) => item.code)).toContain("invoice_in_flight");
    mocks.invoice!.claimed_at = new Date(Date.now() - 10 * 60_000);
    const later = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(later.preview.blockers.map((item) => item.code)).toContain("invoice_outcome_unknown");
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });
});

describe("invoice state machine before the POST (fix for 94da81c)", () => {
  it("releases the claim as safely retryable when the pre-POST lookup is incomplete, then succeeds once the index is complete", async () => {
    mocks.findInvoices
      .mockResolvedValueOnce(noInvoices)
      .mockResolvedValueOnce({ invoices: [], complete: false, indexError: "invoice index not current (4000/13215 indexed)" });
    await expect(applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID)))
      .resolves.toMatchObject({ applied: false, message: expect.stringContaining("nothing sent, safe to retry") });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
    expect(mocks.invoice).toMatchObject({ status: "failed", failure_stage: "pre_post_lookup", claim_token: null });
    // Not an unknown outcome: the next dry run (index now complete) plans and creates the invoice.
    const retry = await planInvoiceRecovery(ORDER_ID);
    expect(retry.action.kind).toBe("create_invoice");
    await expect(applyInvoiceRecovery(retry)).resolves.toMatchObject({ applied: true, status: "created" });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("releases the claim when a pre-POST request throws (nothing sent)", async () => {
    mocks.findInvoices.mockResolvedValueOnce(noInvoices).mockRejectedValueOnce(new Error("KiotViet 503 on GET /invoices"));
    await expect(applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID))).rejects.toThrow("503");
    expect(mocks.invoice).toMatchObject({ status: "failed", failure_stage: "pre_post", claim_token: null });
    expect((await planInvoiceRecovery(ORDER_ID)).action.kind).toBe("create_invoice");
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("marks a duplicate that appeared before the POST as blocked, never as an unknown outcome", async () => {
    mocks.findInvoices.mockResolvedValueOnce(noInvoices).mockResolvedValueOnce({ invoices: [
      { id: 1, code: "HD1", orderCode: "DH1072", status: 1 }, { id: 2, code: "HD2", orderCode: "DH1072", status: 1 },
    ], complete: true });
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_ID));
    expect(mocks.invoice).toMatchObject({ status: "blocked", last_error: expect.stringContaining("duplicate_invoices") });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("treats a stale unsent 'pending' claim as reclaimable, but a fresh one as in flight", async () => {
    const pending = (minutesAgo: number) => ({
      shopify_order_id: ORDER_ID, kiotviet_invoice_id: null, status: "pending", source: "recovery", claim_token: "crashed-worker",
      claimed_at: new Date(Date.now() - minutesAgo * 60_000), created_at: new Date(Date.now() - minutesAgo * 60_000),
      updated_at: "2026-11-04T01:00:00.000Z", expected_total: "90", reconciliation: {},
    });
    mocks.invoice = pending(1);
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("invoice_in_flight")] });
    mocks.invoice = pending(10);
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action.kind).toBe("create_invoice");
    await expect(applyInvoiceRecovery(plan)).resolves.toMatchObject({ applied: true });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("keeps 'creating' (POST may have been sent) as an unknown outcome", async () => {
    mocks.invoice = {
      shopify_order_id: ORDER_ID, kiotviet_invoice_id: null, status: "creating", source: "recovery", claim_token: "t",
      claimed_at: new Date(Date.now() - 10 * 60_000), created_at: new Date(Date.now() - 10 * 60_000), updated_at: "2026-11-04T01:00:00.000Z", reconciliation: {},
    };
    expect((await planInvoiceRecovery(ORDER_ID)).action).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("invoice_outcome_unknown")] });
  });

  it("flags the invoice when KiotViet did not actually inherit the order prepayment", async () => {
    // Full prepayment of 90: the payload records nothing new (totalPayment 0)...
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action).toMatchObject({ kind: "create_invoice", input: { totalPayment: 0 } });
    // ...but the created invoice reports 0 paid instead of the inherited 90.
    mocks.invoiceDetail.mockResolvedValue({ id: 8001, code: "HD8001", orderCode: "DH1072", status: 1, branchId: 10, invoiceDetails: kiotVietOrder().orderDetails, total: 90, totalPayment: 0 });
    await applyInvoiceRecovery(plan);
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "8001", reconciliation: expect.objectContaining({ checks: expect.objectContaining({ payment: false }) }) });
  });
});

describe("override: duplicate submission", () => {
  it("rejects re-submitting a preview after the invoice was created", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submitInvoiceOverride({ orderId: ORDER_ID, admin: "admin", previewToken, approvedWarnings: [], confirm: true, reason: "Duyệt tạo hóa đơn theo đối soát" }))
      .resolves.toMatchObject({ applied: true });
    await expect(submitInvoiceOverride({ orderId: ORDER_ID, admin: "admin", previewToken, approvedWarnings: [], confirm: true, reason: "Duyệt tạo hóa đơn theo đối soát" }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });
});

describe("Shopify #1072 manual exception (KiotViet DH031113, Bỏ qua PLAN: blocked)", () => {
  // Reported production data: merchandise 80, Shopify shipping 10, SVC fee 3.33, KiotViet prepayment 90.
  const prices = { "377": "20.00", "711": "25.00", "1045": "20.00", "1030": "15.00" } as Record<string, string>;
  const codes = ["prepayment_inheritance_unverified", "shipping_not_on_kiotviet_order", "total_mismatch", "unsupported_shipping"];
  const reason = "Kế toán duyệt: phí ship 10 USD đã thu trên Shopify, xử lý chênh lệch thủ công";
  const submit = (previewToken: string, overrides: Record<string, unknown> = {}) => submitInvoiceOverride({
    orderId: ORDER_ID, admin: "admin", previewToken, bypassPlanBlocked: true, approvedWarnings: codes, confirm: true, reason, ...overrides,
  });

  beforeEach(() => {
    mocks.orderMapping = { kiotviet_order_id: "25598189", kiotviet_order_code: "DH031113" };
    mocks.evidence = undefined; // prepayment inheritance not verified
    mocks.event = { id: "e", payload: order1072({
      total_price: "93.33",
      shipping_lines: [{ price: "10.00", discounted_price: "10.00" }],
      line_items: [
        ...products.map((product, index) => ({ id: 100 + index, sku: product.sku, quantity: 1, price: prices[product.sku], title: `Product ${product.sku}` })),
        { id: 999, sku: null, quantity: 1, price: "3.33", title: "SVC Fee - Credit Card Processing Fee" },
      ],
    }) };
    mocks.live.mockResolvedValue({ cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "USD", totalPriceSet: { shopMoney: { amount: "93.33" } }, refunds: [] });
    mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder({
      id: 25598189, code: "DH031113", total: 80, totalPayment: 90,
      orderDetails: products.map((product) => ({ productId: product.productId, productCode: product.sku, productName: product.sku, quantity: 1, price: Number(prices[product.sku]), discount: 0 })),
    }));
    mocks.createInvoice.mockImplementation(async () => {
      for (const product of products) mocks.stock[String(product.productId)] -= 1;
      return { id: 9100, code: "HD031113" };
    });
    mocks.invoiceDetail.mockResolvedValue({
      id: 9100, code: "HD031113", orderCode: "DH031113", status: 1, branchId: 10, total: 80, totalPayment: 90,
      payments: [{ amount: 90, method: "Transfer" }],
      invoiceDetails: products.map((product) => ({ productId: product.productId, quantity: 1, price: Number(prices[product.sku]), discount: 0 })),
    });
  });

  it("keeps automatic invoicing blocked (PLAN: blocked)", async () => {
    const plan = await planInvoiceRecovery(ORDER_ID);
    expect(plan.action.kind).toBe("blocked");
    expect(describeInvoiceRecoveryPlan(plan).join("\n")).toContain("PLAN: blocked");
  });

  it("previews the exact invoice with the unresolved 10 USD discrepancy", async () => {
    const { preview } = await previewInvoiceOverride(ORDER_ID, "admin");
    expect(preview).toMatchObject({
      planStatus: "blocked", submitAllowed: true, blockers: [], reconciled: false,
      kiotVietOrder: { id: 25598189, code: "DH031113" },
      amounts: {
        currency: "USD",
        shopify: { merchandise: 80, shipping: 10, excludedFees: 3.33, total: 93.33, paidForGoods: 90 },
        invoice: { merchandise: 80, surcharges: 0, total: 80 },
        payment: { existingPrepayment: 90, additionalPayment: 0, totalRecorded: 90, overpayment: 10, remainingBalance: 0 },
      },
    });
    expect(preview.warnings.map((warning) => warning.code).sort()).toEqual(codes);
    expect(preview.remainingDifferences).toEqual([
      expect.objectContaining({ code: "shipping_unrecorded", amount: 10 }),
      expect.objectContaining({ code: "overpayment", amount: 10 }),
      expect.objectContaining({ code: "prepayment_inheritance_unverified", amount: 90 }),
    ]);
    // Exact POST /invoices body: existing lines and prices, no added payment, no invented shipping.
    expect(preview.payload).toEqual({
      branchId: 10, orderId: 25598189, customerId: 77, discount: 0, totalPayment: 0, method: "Transfer",
      invoiceDetails: [
        { productId: 377001, productCode: "377", productName: "377", quantity: 1, price: 20, discount: 0 },
        { productId: 711001, productCode: "711", productName: "711", quantity: 1, price: 25, discount: 0 },
        { productId: 1045001, productCode: "1045", productName: "1045", quantity: 1, price: 20, discount: 0 },
        { productId: 1030001, productCode: "1030", productName: "1030", quantity: 1, price: 15, discount: 0 },
      ],
    });
  });

  it("requires the explicit bypass, every approval, confirmation and a reason", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submit(previewToken, { bypassPlanBlocked: false })).rejects.toThrow("Bỏ qua PLAN: blocked");
    await expect(submit(previewToken, { approvedWarnings: codes.slice(1) })).rejects.toThrow("Approve exactly");
    await expect(submit(previewToken, { confirm: false })).rejects.toThrow("Confirm");
    await expect(submit(previewToken, { reason: "ok" })).rejects.toThrow("reason");
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("sends totalPayment 0, stores the invoice ID and leaves it needs_review with the payment rows recorded", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submit(previewToken)).resolves.toMatchObject({ applied: true, invoiceCode: "HD031113", status: "needs_review" });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.createInvoice.mock.calls[0][0]).toMatchObject({ orderId: 25598189, totalPayment: 0 });
    expect(mocks.invoice).toMatchObject({
      status: "needs_review", kiotviet_invoice_id: "9100", kiotviet_invoice_code: "HD031113",
      reconciliation: expect.objectContaining({
        invoice: expect.objectContaining({ totalPayment: 90, paymentRows: [{ amount: 90, method: "Transfer" }] }),
        stockVerified: true,
        checks: expect.objectContaining({ paymentRecords: true, financiallyReconciled: false }),
        manualOverride: expect.objectContaining({ admin: "admin", reason, bypassPlanBlocked: true, planStatus: "blocked", approvedWarnings: codes }),
      }),
    });
    expect(mocks.audit[0]).toMatchObject({ action: "kiotviet_invoice_override_requested", actor: "admin", entityId: ORDER_ID,
      before: expect.objectContaining({ reason, bypassPlanBlocked: true, payloadSummary: expect.objectContaining({ kiotVietOrderCode: "DH031113", invoiceTotal: 80, additionalPayment: 0 }) }) });
    expect(mocks.audit[1]).toMatchObject({ action: "kiotviet_invoice_override_result", after: expect.objectContaining({ applied: true, status: "needs_review" }) });
  });

  it("keeps the returned invoice ID even when reading the invoice back fails", async () => {
    mocks.invoiceDetail.mockRejectedValue(new Error("KiotViet 503 on GET /invoices/9100"));
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submit(previewToken)).resolves.toMatchObject({ applied: true, status: "needs_review", message: expect.stringContaining("ID saved") });
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "9100" });
    // A later dry run treats it as invoiced; nothing is ever created twice.
    expect((await planInvoiceRecovery(ORDER_ID)).action.kind).toBe("none");
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("flags payment rows that do not add up to the reported paid amount", async () => {
    mocks.invoiceDetail.mockResolvedValue({ id: 9100, code: "HD031113", orderCode: "DH031113", status: 1, branchId: 10, total: 80, totalPayment: 90, payments: [{ amount: 90 }, { amount: 90 }],
      invoiceDetails: products.map((product) => ({ productId: product.productId, quantity: 1, price: Number(prices[product.sku]), discount: 0 })) });
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await submit(previewToken);
    expect(mocks.invoice).toMatchObject({ status: "needs_review", reconciliation: expect.objectContaining({ checks: expect.objectContaining({ paymentRecords: false }) }) });
  });

  it("rechecks the invoice index right before the POST and never sends when a duplicate appeared", async () => {
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    mocks.findInvoices.mockResolvedValueOnce(noInvoices).mockResolvedValueOnce({ invoices: [{ id: 1, code: "HD1", orderCode: "DH031113", status: 1 }, { id: 2, code: "HD2", orderCode: "DH031113", status: 1 }], complete: true });
    await expect(submit(previewToken)).resolves.toMatchObject({ applied: false, message: expect.stringContaining("duplicate_invoices") });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("never retries an uncertain POST", async () => {
    mocks.createInvoice.mockImplementationOnce(async () => { throw new UncertainResultError("timeout"); });
    const { previewToken } = await previewInvoiceOverride(ORDER_ID, "admin");
    await expect(submit(previewToken)).resolves.toMatchObject({ applied: false, message: expect.stringContaining("NOT resent") });
    await expect(submit(previewToken)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.invoice).toMatchObject({ status: "creating" });
  });
});
