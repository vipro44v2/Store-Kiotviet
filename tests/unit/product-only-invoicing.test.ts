vi.mock("@/lib/shopify/invoice-order", () => ({ getInvoiceOrder: async () => structuredClone(mocks.event?.payload) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyOrderWebhook } from "@/types/shopify";

/**
 * Product-Only Invoicing. Every KiotViet and Shopify call is mocked: no test
 * reaches a production invoice endpoint (see also tests/setup/no-network.ts).
 */
const mocks = vi.hoisted(() => ({
  orderId: "",
  orderNumber: "",
  kiotVietOrderId: 0,
  kiotVietOrderCode: "",
  users: [] as Array<Record<string, unknown>>,
  evidence: undefined as Record<string, unknown> | undefined,
  invoice: undefined as Record<string, unknown> | undefined,
  orderSettings: {} as Record<string, unknown>,
  event: undefined as { id: string; payload: unknown } | undefined,
  stock: {} as Record<string, number>,
  audit: [] as unknown[],
  kiotVietOrder: vi.fn(),
  live: vi.fn(),
  findInvoices: vi.fn(),
  createInvoice: vi.fn(),
  invoiceDetail: vi.fn(),
  findBySku: vi.fn(),
}));

function run(sql: string, params: unknown[]): Record<string, unknown>[] {
  const now = () => new Date(Date.now() + Math.random() * 1000).toISOString();
  if (sql.includes("pg_advisory_xact_lock")) return [];
  if (sql.startsWith("INSERT INTO audit_logs")) { mocks.audit.push(params); return []; }
  if (sql.includes("FROM order_mappings"))
    return [{ shopify_order_id: mocks.orderId, shopify_order_number: mocks.orderNumber, kiotviet_order_id: String(mocks.kiotVietOrderId), kiotviet_order_code: mocks.kiotVietOrderCode, status: "created" }];
  if (sql.includes("FROM system_settings"))
    return params[0] === "kiotviet_prepayment_evidence" ? (mocks.evidence ? [{ value: mocks.evidence }] : []) : [{ value: mocks.orderSettings }];
  if (sql.includes("FROM branch_location_mappings")) return [{}];
  if (sql.startsWith("SELECT") && sql.includes("FROM invoice_mappings")) return mocks.invoice ? [{ ...mocks.invoice }] : [];
  const row = mocks.invoice;
  if (sql.startsWith("INSERT INTO invoice_mappings")) {
    if (row) {
      const allowed = !row.kiotviet_invoice_id && params[8] !== null && row.updated_at === params[8] && ["failed", "blocked"].includes(String(row.status));
      if (!allowed) return [];
    }
    mocks.invoice = {
      ...(row ?? { kiotviet_invoice_id: null, created_at: new Date() }), shopify_order_id: mocks.orderId,
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
  if (sql.startsWith("UPDATE invoice_mappings SET status='failed'")) {
    if (row.claim_token === params[1]) Object.assign(row, { status: "failed", claim_token: null, updated_at: now() });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status=$4")) {
    if (row.claim_token !== params[1] || row.status !== "pending") return [];
    Object.assign(row, { status: params[3], claim_token: null, last_error: params[2], failure_stage: params[4], updated_at: now() });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET status='needs_review'")) {
    if (row.claim_token !== params[1] || row.kiotviet_invoice_id) return [];
    Object.assign(row, { status: "needs_review", claim_token: null, last_error: params[2], updated_at: now() });
    return [];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET last_error")) { Object.assign(row, { last_error: params[2], updated_at: now() }); return []; }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_invoice_id=$3")) {
    if (row.claim_token !== params[1] || (sql.includes("kiotviet_invoice_id IS NULL") && row.kiotviet_invoice_id)) return [];
    Object.assign(row, { kiotviet_invoice_id: String(params[2]), kiotviet_invoice_code: params[3], status: "needs_review", updated_at: now() });
    return [{ shopify_order_id: row.shopify_order_id }];
  }
  if (sql.startsWith("UPDATE invoice_mappings SET kiotviet_invoice_id=$2")) {
    if (row.kiotviet_invoice_id && row.kiotviet_invoice_id !== String(params[1])) return [];
    Object.assign(row, { kiotviet_invoice_id: String(params[1]), kiotviet_invoice_code: params[2], status: params[3], reconciliation: JSON.parse(String(params[4])), last_error: params[5], updated_at: now() });
    return [{}];
  }
  throw new Error(`Unhandled SQL: ${sql.slice(0, 70)}`);
}

vi.mock("@/lib/db/client", () => ({
  query: async (sql: string, params: unknown[] = []) => run(sql, params),
  transaction: async (callback: (client: unknown) => Promise<unknown>) =>
    callback({ query: async (sql: string, params: unknown[] = []) => ({ rows: run(sql, params) }) }),
}));
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
vi.mock("@/lib/env", () => ({ getEnv: () => ({ SESSION_SECRET: "test-session-secret-0123456789abcdef", KIOTVIET_DEFAULT_SOLD_BY_ID: "" }) }));
vi.mock("@/lib/kiotviet/branches", () => ({ getActiveKiotVietBranches: async () => [{ id: 10 }] }));
vi.mock("@/lib/kiotviet/client", () => ({
  kiotVietClient: {
    get: async (url: string) => {
      if (!url.startsWith("/users")) throw new Error(`Unexpected KiotViet GET ${url}`);
      return { total: mocks.users.length, pageSize: 100, data: mocks.users };
    },
    post: async () => { throw new Error("Production KiotViet POST attempted in a test"); },
  },
}));

import { applyInvoiceRecovery, describeInvoiceRecoveryPlan, planInvoiceRecovery } from "@/lib/recovery/kiotviet-invoice-recovery";
import { previewInvoiceOverride } from "@/lib/recovery/invoice-override";
import { evaluateInvoiceFinancials } from "@/lib/sync/invoice-financials";
import { prepareOrderForKiotViet } from "@/lib/sync/order-sync";
import { productOnlyPaymentDecision, productOnlyPolicy } from "@/lib/sync/product-only-invoicing";
import { ordersSettingsSchema } from "@/lib/settings/order-settings";
import { UncertainResultError } from "@/lib/errors";

const productOnlySettings = {
  defaultBranchId: 10, kiotVietCurrency: "USD", invoiceCreationTrigger: "shopify_fulfilled",
  productOnlyInvoicing: true, paymentSource: "shopify",
};
const carriedEvidence = {
  retailer: "sandbox-shop", testedAt: "2026-11-04T08:00:00.000Z",
  order: { id: 1, code: "DH-TEST", total: 100, prepaid: 100 },
  invoice: { id: 2, code: "HD-TEST", requestedTotalPayment: 0, total: 100, totalPayment: 100, paymentRows: [{ amount: 100 }] },
  orderAfter: { status: 3, totalPayment: 100 }, result: "carried",
};

interface Fixture {
  orderId: string; name: string; kiotVietOrderId: number; kiotVietOrderCode: string;
  lines: Array<{ sku: string; productId: number; quantity: number; price: string; discount?: string }>;
  shipping?: string; fee?: string; total: string; prepaid: number;
}
/**
 * Regression fixtures. Order IDs, KiotViet codes, merchandise, shipping and
 * prepayment come from the incident reports; the split into product lines is
 * illustrative (the reports give only totals).
 */
const ORDER_1071: Fixture = {
  orderId: "7107364880568", name: "#1071", kiotVietOrderId: 31121, kiotVietOrderCode: "DH031121",
  lines: [{ sku: "1071-A", productId: 107101, quantity: 2, price: "52.00" }, { sku: "1071-B", productId: 107102, quantity: 1, price: "50.00" }],
  shipping: "10.00", total: "164.00", prepaid: 164,
};
const ORDER_1082: Fixture = {
  orderId: "7133915545784", name: "#1082", kiotVietOrderId: 31389, kiotVietOrderCode: "DH031389",
  lines: [{ sku: "1082-A", productId: 108201, quantity: 2, price: "101.00" }],
  fee: "8.42", total: "210.42", prepaid: 202,
};

let fixture: Fixture;
const unitCents = (line: Fixture["lines"][number]) =>
  (Math.round(Number(line.price) * 100) * line.quantity - Math.round(Number(line.discount ?? 0) * 100)) / line.quantity;
const shopifyOrder = (f: Fixture, overrides: Partial<ShopifyOrderWebhook> = {}): ShopifyOrderWebhook => ({
  id: Number(f.orderId), name: f.name, financial_status: "paid", currency: "USD", total_price: f.total, refunds: [],
  updated_at: "2026-11-04T10:00:00Z",
  line_items: [
    ...f.lines.map((line, index) => ({ id: 100 + index, sku: line.sku, quantity: line.quantity, price: line.price, title: line.sku,
      discount_allocations: line.discount ? [{ amount: line.discount }] : [] })),
    ...(f.fee ? [{ id: 999, sku: null, quantity: 1, price: f.fee, title: "SVC Fee - Credit Card Processing Fee" }] : []),
  ],
  shipping_lines: f.shipping ? [{ price: f.shipping, discounted_price: f.shipping }] : [],
  ...overrides,
});
const kiotVietOrder = (f: Fixture, overrides: Record<string, unknown> = {}) => {
  const orderDetails = f.lines.map((line) => ({ productId: line.productId, productCode: line.sku, productName: line.sku, quantity: line.quantity, price: unitCents(line) / 100, discount: 0 }));
  return {
    id: f.kiotVietOrderId, code: f.kiotVietOrderCode, branchId: 10, status: 1, customerId: 77, soldById: 1000012735,
    total: orderDetails.reduce((sum, detail) => sum + detail.price * detail.quantity, 0), totalPayment: f.prepaid,
    createdDate: "2026-11-03T00:00:00Z", orderDetails, ...overrides,
  };
};
const invoiceDetail = (f: Fixture, overrides: Record<string, unknown> = {}) => {
  const order = kiotVietOrder(f);
  return { id: 8001, code: "HD8001", orderCode: f.kiotVietOrderCode, status: 1, branchId: 10, invoiceDetails: order.orderDetails,
    total: order.total, totalPayment: f.prepaid, payments: [{ amount: f.prepaid, method: "Transfer" }], ...overrides };
};

function use(f: Fixture, options: { snapshot?: Partial<ShopifyOrderWebhook>; kiotViet?: Record<string, unknown> } = {}) {
  fixture = f;
  Object.assign(mocks, { orderId: f.orderId, orderNumber: f.name, kiotVietOrderId: f.kiotVietOrderId, kiotVietOrderCode: f.kiotVietOrderCode });
  const snapshot = shopifyOrder(f, options.snapshot);
  mocks.event = { id: `event-${f.name}`, payload: snapshot };
  mocks.live.mockResolvedValue({ updatedAt: snapshot.updated_at, cancelledAt: snapshot.cancelled_at ?? null, displayFinancialStatus: String(snapshot.financial_status).toUpperCase(),
    currencyCode: "USD", totalPriceSet: { shopMoney: { amount: snapshot.total_price } }, refunds: snapshot.refunds ?? [] });
  mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder(f, options.kiotViet));
  mocks.findBySku.mockImplementation(async (sku: string) => {
    const line = f.lines.find((item) => item.sku.toLowerCase() === sku.toLowerCase());
    return line ? [{ kiotviet_product_id: String(line.productId), sync_status: "mapped" }] : [];
  });
  for (const line of f.lines) mocks.stock[String(line.productId)] = 20;
  mocks.createInvoice.mockImplementation(async () => {
    for (const line of f.lines) mocks.stock[String(line.productId)] -= line.quantity;
    return { id: 8001, code: "HD8001" };
  });
  mocks.invoiceDetail.mockResolvedValue(invoiceDetail(f));
}
const blockedCodes = (plan: Awaited<ReturnType<typeof planInvoiceRecovery>>) =>
  plan.action.kind === "blocked" ? plan.action.reasons.map((reason) => reason.split(":")[0]) : [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoice = undefined;
  mocks.audit = [];
  mocks.orderSettings = { ...productOnlySettings };
  mocks.users = [{ id: 1000012735, userName: "dung", givenName: "Dũng" }];
  mocks.evidence = undefined;
  mocks.findInvoices.mockResolvedValue({ invoices: [], complete: true });
  use(ORDER_1082);
});

const prepare = (order: ShopifyOrderWebhook, settings: Record<string, unknown> = productOnlySettings) => {
  const prepared = prepareOrderForKiotViet(order, settings);
  return evaluateInvoiceFinancials(order, prepared, settings);
};

describe("settings", () => {
  it("defaults to strict invoicing for existing installations", () => {
    expect(productOnlyPolicy({}).enabled).toBe(false);
    expect(productOnlyPolicy({ excludeShipping: true }).excludeShipping).toBe(false);
  });
  it("turns every exclusion on when the mode is explicitly selected", () => {
    expect(productOnlyPolicy({ productOnlyInvoicing: true })).toEqual({
      enabled: true, paymentSource: "shopify", ignoreFinancialMismatch: true, excludeShipping: true, excludeProcessingFees: true, excludeOtherSurcharges: true,
      allowUnverifiedPrepaymentInheritance: false, prepaymentExceedsInvoicePolicy: "block",
    });
    expect(productOnlyPolicy({ productOnlyInvoicing: true, excludeShipping: false }).excludeShipping).toBe(false);
  });
  it("requires an explicit trigger (never the legacy makeInvoice path) and only Shopify as payment source", () => {
    expect(ordersSettingsSchema.safeParse({ productOnlyInvoicing: true }).success).toBe(false);
    expect(ordersSettingsSchema.safeParse({ ...productOnlySettings, paymentSource: "kiotviet" }).success).toBe(false);
    expect(ordersSettingsSchema.safeParse(productOnlySettings).success).toBe(true);
    // The configured trigger is preserved as-is.
    expect(ordersSettingsSchema.parse({ ...productOnlySettings, invoiceCreationTrigger: "shopify_paid" }).invoiceCreationTrigger).toBe("shopify_paid");
  });
});

describe("product-only invoice values", () => {
  it("excludes shipping: invoice = merchandise, the 10 USD difference is recorded (#1071)", () => {
    const financials = prepare(shopifyOrder(ORDER_1071));
    expect(financials).toMatchObject({ eligible: true, mode: "product_only", merchandiseTotal: 154, expectedPayment: 154, shopifyPaidTotal: 164 });
    expect(financials.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "shipping_excluded", amount: 10 }),
      expect.objectContaining({ code: "shopify_paid_vs_invoice", amount: 10 }),
    ]));
  });

  it("blocks shipping when excludeShipping was explicitly turned off", () => {
    const financials = prepare(shopifyOrder(ORDER_1071), { ...productOnlySettings, excludeShipping: false });
    expect(financials.reasons).toEqual([expect.stringContaining("shipping_not_excluded")]);
  });

  it("excludes processing fees", () => {
    const financials = prepare(shopifyOrder({ ...ORDER_1082, fee: "6.06", total: "208.06" }));
    expect(financials).toMatchObject({ eligible: true, merchandiseTotal: 202 });
    expect(financials.differences).toEqual(expect.arrayContaining([expect.objectContaining({ code: "processing_fee_excluded", amount: 6.06 })]));
  });

  it("applies product discounts as a discounted unit price", () => {
    const discounted = { ...ORDER_1082, fee: undefined, lines: [{ sku: "1082-A", productId: 108201, quantity: 2, price: "101.00", discount: "20.00" }], total: "182.00" };
    const financials = prepare(shopifyOrder(discounted));
    expect(financials).toMatchObject({ eligible: true, merchandiseTotal: 182, unitPrices: { "100": 91 } });
  });

  it("blocks a discount that cannot be split into whole cents per unit", () => {
    const odd = { ...ORDER_1082, fee: undefined, lines: [{ sku: "1082-A", productId: 108201, quantity: 3, price: "10.00", discount: "10.00" }], total: "20.00" };
    expect(prepare(shopifyOrder(odd)).reasons).toEqual([expect.stringContaining("discount_not_representable")]);
  });

  it("excludes tips and other non-product charges, but blocks a total below the merchandise", () => {
    expect(prepare(shopifyOrder({ ...ORDER_1082, fee: undefined, total: "209.00" }, { total_tip_received: "5.00" })).differences)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "tip_excluded", amount: 5 }), expect.objectContaining({ code: "other_charges_excluded", amount: 2 })]));
    expect(prepare(shopifyOrder({ ...ORDER_1082, fee: undefined, total: "190.00" })).reasons).toEqual([expect.stringContaining("amount_mismatch")]);
  });

  it("keeps added product tax as a blocker (tax is not a surcharge)", () => {
    const order = shopifyOrder({ ...ORDER_1082, fee: undefined });
    order.line_items[0].tax_lines = [{ price: "16.16" }];
    order.total_price = "218.16";
    expect(prepare(order).reasons).toEqual([expect.stringContaining("unsupported_tax")]);
  });

  it("handles partial refunds explicitly", () => {
    const shippingRefund = shopifyOrder(ORDER_1071, { financial_status: "partially_refunded", refunds: [{ id: 1, refund_line_items: [], transactions: [{ kind: "refund", status: "success", amount: "10.00" }] }] });
    expect(prepare(shippingRefund)).toMatchObject({ eligible: true, shopifyPaidTotal: 154 });
    const productRefund = shopifyOrder(ORDER_1071, { financial_status: "partially_refunded", refunds: [{ id: 2, refund_line_items: [{ line_item_id: 100, quantity: 1 }], transactions: [{ kind: "refund", status: "success", amount: "52.00" }] }] });
    expect(prepare(productRefund).reasons).toEqual(expect.arrayContaining([expect.stringContaining("refund_affects_products"), expect.stringContaining("refund_exceeds_excluded_charges")]));
  });

  it("uses Shopify payment status and cancellation as authority", () => {
    expect(prepare(shopifyOrder(ORDER_1082, { financial_status: "pending" })).reasons).toEqual([expect.stringContaining("not_paid")]);
    expect(prepare(shopifyOrder(ORDER_1082, { cancelled_at: "2026-11-04" })).reasons).toEqual([expect.stringContaining("order_cancelled")]);
  });

  it("leaves strict invoicing unchanged when the mode is off", () => {
    const strict = { defaultBranchId: 10, kiotVietCurrency: "USD" };
    expect(prepare(shopifyOrder(ORDER_1071), strict).reasons).toEqual(expect.arrayContaining([expect.stringContaining("unsupported_shipping")]));
  });
});

describe("payment safety (no payment is ever created by the invoice)", () => {
  const base = { invoiceTotalCents: 20_200, shopifyPaidCents: 20_200, inheritanceVerified: true };
  it.each([
    [0, "kiotviet_payment_missing"],
    [21_200, "prepayment_exceeds_invoice"],
    [10_000, "prepayment_below_invoice"],
  ])("prepaid %i cents → %s", (prepaidCents, code) => {
    expect(productOnlyPaymentDecision({ ...base, prepaidCents })).toMatchObject({ safe: false, reason: expect.stringContaining(code) });
  });
  it("only an exact, verified prepayment is safe, and then nothing is added", () => {
    expect(productOnlyPaymentDecision({ ...base, prepaidCents: 20_200, inheritanceVerified: false })).toMatchObject({ safe: false, reason: expect.stringContaining("prepayment_inheritance_unverified") });
    expect(productOnlyPaymentDecision({ ...base, prepaidCents: 20_200 })).toEqual({ safe: true, additionalPayment: 0, expectedInvoicePayment: 202, prepaymentPolicy: "verified" });
  });
});

describe("Shopify #1071 (KiotViet DH031121): 154 merchandise, 10 shipping, 164 prepaid", () => {
  beforeEach(() => use(ORDER_1071));

  it("plans a 154 USD product-only invoice and reports the 10 USD payment difference", async () => {
    mocks.evidence = carriedEvidence;
    mocks.orderSettings.invoicePrepaymentVerified = true;
    const plan = await planInvoiceRecovery(ORDER_1071.orderId);
    expect(plan.productOnly).toMatchObject({ invoiceMerchandise: 154, shopifyPaid: 164, kiotVietPrepaid: 164, additionalPayment: 0, financiallyReconciled: false });
    expect(plan.productOnly?.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "shipping_excluded", amount: 10 }),
      expect.objectContaining({ code: "kiotviet_prepaid_vs_invoice", amount: 10 }),
    ]));
    // Shipping and totals no longer block; only the unverified 164-on-154 payment carry does.
    expect(blockedCodes(plan)).toEqual(["prepayment_exceeds_invoice"]);
    expect(describeInvoiceRecoveryPlan(plan).join("\n")).toContain("invoice_merchandise=154 kiotviet_prepaid=164 additional_payment=0");
    await applyInvoiceRecovery(plan);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("is blocked even for the manual override under the default overpayment policy", async () => {
    const { preview } = await previewInvoiceOverride(ORDER_1071.orderId, "admin");
    expect(preview.blockers.map((item) => item.code)).toContain("prepayment_exceeds_invoice");
    expect(preview.submitAllowed).toBe(false);
  });

  it("is never invoiced automatically, even with the unverified-inheritance policy", async () => {
    Object.assign(mocks.orderSettings, { allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true });
    expect(blockedCodes(await planInvoiceRecovery(ORDER_1071.orderId))).toEqual(["prepayment_exceeds_invoice"]);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("offers the manual override with totalPayment 0 and the difference visible when the policy allows it", async () => {
    mocks.orderSettings.prepaymentExceedsInvoicePolicy = "manual_override";
    const { preview } = await previewInvoiceOverride(ORDER_1071.orderId, "admin");
    expect(preview.warnings.map((warning) => warning.code)).toContain("prepayment_exceeds_invoice");
    expect(preview.payload).toMatchObject({ totalPayment: 0 });
    expect(preview.amounts?.invoice).toMatchObject({ merchandise: 154, surcharges: 0, total: 154 });
    expect(preview.remainingDifferences).toEqual(expect.arrayContaining([expect.objectContaining({ code: "overpayment", amount: 10 })]));
    expect(preview.reconciled).toBe(false);
  });
});

describe("Shopify #1082 (KiotViet DH031389): 202 merchandise, 202 prepaid", () => {
  it("stays blocked until prepayment inheritance is verified (no evidence recorded yet)", async () => {
    const plan = await planInvoiceRecovery(ORDER_1082.orderId);
    expect(blockedCodes(plan)).toEqual(["prepayment_inheritance_unverified"]);
  });

  it("stays blocked while duplicate detection is inconclusive", async () => {
    mocks.evidence = carriedEvidence;
    mocks.orderSettings.invoicePrepaymentVerified = true;
    mocks.findInvoices.mockResolvedValue({ invoices: [], complete: false, indexError: "invoice index not current" });
    expect(blockedCodes(await planInvoiceRecovery(ORDER_1082.orderId))).toContain("invoice_lookup_incomplete");
  });

  it("creates exactly one 202 USD invoice with no additional payment once verified", async () => {
    mocks.evidence = carriedEvidence;
    mocks.orderSettings.invoicePrepaymentVerified = true;
    const plan = await planInvoiceRecovery(ORDER_1082.orderId);
    expect(plan.action).toMatchObject({ kind: "create_invoice", input: { orderId: 31389, totalPayment: 0, discount: 0,
      invoiceDetails: [expect.objectContaining({ productId: 108201, quantity: 2, price: 101, discount: 0 })] } });
    const result = await applyInvoiceRecovery(plan);
    expect(result).toMatchObject({ applied: true, status: "created" });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.invoice).toMatchObject({ status: "created", kiotviet_invoice_id: "8001", expected_total: "202",
      reconciliation: expect.objectContaining({ invoicingMode: "product_only", stockVerified: true, expectedPaymentTotal: 202,
        productOnly: expect.objectContaining({ paymentSource: "shopify", shopifyPaid: 210.42, invoiceMerchandise: 202 }) }) });
    // Re-running never creates a second invoice.
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });
});

describe("new product-only orders", () => {
  const NEW_ORDER: Fixture = { ...ORDER_1082, orderId: "7200000000001", name: "#1200", kiotVietOrderId: 40001, kiotVietOrderCode: "DH040001", shipping: "10.00", fee: "6.36", total: "218.36" };
  beforeEach(() => {
    use(NEW_ORDER);
    mocks.evidence = carriedEvidence;
    mocks.orderSettings.invoicePrepaymentVerified = true;
  });

  it("is created (not needs_review) despite excluded shipping and fees, which stay recorded and unreconciled", async () => {
    await applyInvoiceRecovery(await planInvoiceRecovery(NEW_ORDER.orderId));
    expect(mocks.invoice).toMatchObject({ status: "created", reconciliation: expect.objectContaining({ financiallyReconciled: false,
      productOnly: expect.objectContaining({ shopifyPaid: 218.36, invoiceMerchandise: 202, financiallyReconciled: false }) }) });
    const reconciliation = mocks.invoice?.reconciliation as { checks: Record<string, boolean>; productOnly: { differences: Array<{ code: string }> } };
    expect(reconciliation.checks).not.toHaveProperty("financiallyReconciled");
    expect(reconciliation.productOnly.differences.map((difference) => difference.code)).toEqual(expect.arrayContaining(["shipping_excluded", "processing_fee_excluded"]));
  });

  it("invoices a discounted order at its discounted unit price", async () => {
    use({ ...NEW_ORDER, lines: [{ sku: "1082-A", productId: 108201, quantity: 2, price: "101.00", discount: "20.00" }], total: "198.36", prepaid: 182 });
    mocks.invoiceDetail.mockResolvedValue(invoiceDetail(fixture));
    const plan = await planInvoiceRecovery(NEW_ORDER.orderId);
    expect(plan.action).toMatchObject({ kind: "create_invoice", input: { invoiceDetails: [expect.objectContaining({ price: 91, quantity: 2 })] } });
    await applyInvoiceRecovery(plan);
    expect(mocks.invoice).toMatchObject({ status: "created", expected_total: "182" });
  });

  it.each([
    ["the invoice carried a surcharge", { invoiceOrderSurcharges: [{ surchargeId: 3, price: 10 }], total: 212 }, "total"],
    ["the invoice lines differ", { invoiceDetails: [{ productId: 108201, quantity: 1, price: 101 }] }, "lines"],
  ])("goes to needs_review when %s", async (_label, change, check) => {
    mocks.invoiceDetail.mockResolvedValue(invoiceDetail(fixture, change));
    await applyInvoiceRecovery(await planInvoiceRecovery(NEW_ORDER.orderId));
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "8001",
      reconciliation: expect.objectContaining({ checks: expect.objectContaining({ [check]: false }) }) });
  });

  it("goes to needs_review when the stock did not move by the invoiced quantity", async () => {
    mocks.createInvoice.mockResolvedValue({ id: 8001, code: "HD8001" });
    await applyInvoiceRecovery(await planInvoiceRecovery(NEW_ORDER.orderId));
    expect(mocks.invoice).toMatchObject({ status: "needs_review", reconciliation: expect.objectContaining({ stockVerified: false }) });
  });

  it("never resends after a KiotViet invoice API timeout", async () => {
    mocks.createInvoice.mockRejectedValue(new UncertainResultError("KiotViet POST /invoices network failure or timeout"));
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(NEW_ORDER.orderId));
    expect(result).toMatchObject({ applied: false, message: expect.stringContaining("NOT resent") });
    expect(mocks.invoice).toMatchObject({ status: "creating" });
    const again = await planInvoiceRecovery(NEW_ORDER.orderId);
    expect(blockedCodes(again)).toContain("invoice_in_flight");
    mocks.invoice!.claimed_at = new Date(Date.now() - 10 * 60_000);
    expect(blockedCodes(await planInvoiceRecovery(NEW_ORDER.orderId))).toContain("invoice_outcome_unknown");
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("links (never duplicates) an invoice that already exists, and blocks on two", async () => {
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", status: 1 }], complete: true });
    expect((await planInvoiceRecovery(NEW_ORDER.orderId)).action).toMatchObject({ kind: "link", invoice: { id: 8001 } });
    mocks.findInvoices.mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", status: 1 }, { id: 8002, code: "HD8002", status: 1 }], complete: true });
    expect(blockedCodes(await planInvoiceRecovery(NEW_ORDER.orderId))).toEqual(["duplicate_invoices"]);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["an unmapped SKU", () => mocks.findBySku.mockResolvedValue([]), "sku_unmapped"],
    ["a deleted seller", () => { mocks.users = []; }, "seller_invalid"],
    ["a different quantity in KiotViet", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder(fixture, { orderDetails: [{ productId: 108201, quantity: 1, price: 101 }], total: 101, totalPayment: 101 })), "quantity_mismatch"],
    ["a price that ignores the discount", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder(fixture, { orderDetails: [{ productId: 108201, quantity: 2, price: 105 }], total: 210, totalPayment: 210 })), "price_mismatch"],
    ["a surcharge on an older KiotViet order", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder(fixture, { invoiceOrderSurcharges: [{ surchargeId: 3, price: 10 }], total: 212 })), "kiotviet_order_has_surcharge"],
    ["a KiotViet order without payment", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder(fixture, { totalPayment: 0 })), "kiotviet_payment_missing"],
    ["a cancelled KiotViet order", () => mocks.kiotVietOrder.mockResolvedValue(kiotVietOrder(fixture, { status: 4 })), "kiotviet_order_cancelled"],
  ])("blocks %s", async (_label, arrange, code) => {
    arrange();
    expect(blockedCodes(await planInvoiceRecovery(NEW_ORDER.orderId))).toContain(code);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });
});

describe("#1082 with Allow Unverified Prepayment Inheritance (no sandbox evidence)", () => {
  const allow = () => Object.assign(mocks.orderSettings, { allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true });
  const invoiceRow = () => mocks.invoice as { status: string; kiotviet_invoice_id: string; last_error: string | null;
    reconciliation: { paymentVerification: Record<string, unknown>; productOnly: Record<string, unknown> } };

  it("still blocks while the setting is off, or on without the recorded confirmation, or outside Product-Only", async () => {
    expect(blockedCodes(await planInvoiceRecovery(ORDER_1082.orderId))).toEqual(["prepayment_inheritance_unverified"]);
    mocks.orderSettings.allowUnverifiedPrepaymentInheritance = true;
    expect(blockedCodes(await planInvoiceRecovery(ORDER_1082.orderId))).toEqual(["prepayment_inheritance_unverified"]);
    // Strict invoicing ignores the setting entirely.
    mocks.orderSettings = { defaultBranchId: 10, kiotVietCurrency: "USD", allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true };
    expect(blockedCodes(await planInvoiceRecovery(ORDER_1082.orderId))).toContain("prepayment_inheritance_unverified");
  });

  it("creates the 202 USD invoice with no new payment, only after duplicate checks pass", async () => {
    allow();
    const plan = await planInvoiceRecovery(ORDER_1082.orderId);
    expect(plan.productOnly).toMatchObject({ invoiceMerchandise: 202, shopifyPaid: 210.42, kiotVietPrepaid: 202, additionalPayment: 0, prepaymentPolicy: "unverified_accepted" });
    expect(plan.productOnly?.differences).toEqual(expect.arrayContaining([expect.objectContaining({ code: "processing_fee_excluded", amount: 8.42 })]));
    expect(plan.action).toMatchObject({ kind: "create_invoice", input: { totalPayment: 0 } });
    await applyInvoiceRecovery(plan);
    // Duplicate lookup in the plan and again right before the POST.
    expect(mocks.findInvoices).toHaveBeenCalledTimes(2);
    expect(mocks.findInvoices.mock.invocationCallOrder[1]).toBeLessThan(mocks.createInvoice.mock.invocationCallOrder[0]);
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("marks the payment verified when KiotViet carried the prepayment", async () => {
    allow();
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(invoiceRow()).toMatchObject({ status: "created", kiotviet_invoice_id: "8001", last_error: null });
    expect(invoiceRow().reconciliation.paymentVerification).toMatchObject({
      status: "verified", policy: "unverified_accepted", expectedPaid: 202, invoiceTotalPayment: 202, paymentRowsTotal: 202, remainingBalance: 0, discrepancies: [],
    });
  });

  it.each([
    ["not inherited", { totalPayment: 0, payments: [] }, ["invoice reports 0.00 paid, expected the carried prepayment 202.00", "remaining balance 202.00"]],
    ["partly inherited", { totalPayment: 150, payments: [{ amount: 150 }] }, ["invoice reports 150.00 paid", "remaining balance 52.00"]],
    ["inconsistent payment records", { payments: [{ amount: 100 }] }, ["payment records total 100.00 but the invoice reports 202.00 paid"]],
    ["no payment records", { payments: null }, ["invoice returned no payment records"]],
  ])("creates the invoice (payment is informational) and records the exact discrepancy when the payment is %s", async (_label, change, expected) => {
    allow();
    mocks.invoiceDetail.mockResolvedValue(invoiceDetail(fixture, change));
    const { log } = await import("@/lib/logger");
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    const row = invoiceRow();
    // Identity, lines, total and stock were verified: created. Shopify Paid decides the customer paid.
    expect(row).toMatchObject({ status: "created", kiotviet_invoice_id: "8001", last_error: null });
    expect(row.reconciliation.paymentVerification).toMatchObject({ status: "mismatch", blocking: false, customerPaymentSource: "shopify",
      kiotVietInvoiceFullyPaid: false, discrepancies: expect.arrayContaining(expected.map((text) => expect.stringContaining(text))) });
    expect((row.reconciliation as unknown as { checks: Record<string, boolean> }).checks).not.toHaveProperty("payment");
    // The financial warning stays in the logs.
    expect(vi.mocked(log)).toHaveBeenCalledWith("warn", expect.stringContaining("payment differs"), expect.objectContaining({ action: "kiotviet_invoice_payment_discrepancy" }));
    // Never repaired by creating the invoice again.
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect((await planInvoiceRecovery(ORDER_1082.orderId)).action.kind).toBe("none");
  });

  it("keeps the returned invoice ID when reading the invoice back fails", async () => {
    allow();
    mocks.invoiceDetail.mockRejectedValue(new Error("KiotViet 503"));
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(result).toMatchObject({ applied: true, status: "needs_review" });
    expect(invoiceRow()).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "8001" });
  });

  it("issues one invoice for concurrent invoice jobs", async () => {
    allow();
    const plans = await Promise.all([planInvoiceRecovery(ORDER_1082.orderId), planInvoiceRecovery(ORDER_1082.orderId)]);
    const results = await Promise.all(plans.map((plan) => applyInvoiceRecovery(plan)));
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(results.filter((result) => result.applied)).toHaveLength(1);
  });
});

describe("invoice POST timeout: search and link, never resend", () => {
  const allow = () => Object.assign(mocks.orderSettings, { allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true });
  const timeout = () => mocks.createInvoice.mockImplementation(async () => {
    for (const line of fixture.lines) mocks.stock[String(line.productId)] -= line.quantity; // KiotViet did create it
    throw new UncertainResultError("KiotViet POST /invoices network failure or timeout; the request may have been applied");
  });
  const empty = { invoices: [], complete: true };
  const found = { invoices: [{ id: 8001, code: "HD8001", orderCode: "DH031389", status: 1 }], complete: true };

  it("links the invoice the timed-out POST created and verifies it (stock and payment)", async () => {
    allow();
    timeout();
    // plan, pre-POST re-check, then the first search after the timeout finds nothing, the second finds it.
    mocks.findInvoices.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockResolvedValueOnce(found);
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(result).toMatchObject({ applied: true, invoiceCode: "HD8001", status: "created", message: expect.stringContaining("POST timed out; linked invoice HD8001") });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    expect(mocks.invoice).toMatchObject({ status: "created", kiotviet_invoice_id: "8001",
      reconciliation: expect.objectContaining({ stockVerified: true, uncertainPost: expect.objectContaining({ linkedInvoice: "HD8001" }),
        paymentVerification: expect.objectContaining({ status: "verified" }) }) });
  });

  it("keeps the outcome unknown (creating) when nothing is found, and a later run does not resend", async () => {
    allow();
    timeout();
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(result).toMatchObject({ applied: false, message: expect.stringContaining("NOT resent") });
    expect(mocks.invoice).toMatchObject({ status: "creating", kiotviet_invoice_id: null });
    // The job retries: the plan links as soon as the invoice becomes visible.
    mocks.findInvoices.mockResolvedValue(found);
    const replanned = await planInvoiceRecovery(ORDER_1082.orderId);
    expect(replanned.action).toMatchObject({ kind: "link", invoice: { id: 8001 } });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("does not treat a failed search as proof of anything", async () => {
    allow();
    timeout();
    mocks.findInvoices.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockRejectedValue(new Error("KiotViet 503"));
    await expect(applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId))).resolves.toMatchObject({ applied: false });
    expect(mocks.invoice).toMatchObject({ status: "creating" });
  });

  it("flags two invoices after an uncertain POST as needs_review without linking either", async () => {
    allow();
    timeout();
    mocks.findInvoices.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
      .mockResolvedValue({ invoices: [...found.invoices, { id: 8002, code: "HD8002", orderCode: "DH031389", status: 1 }], complete: true });
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(result).toMatchObject({ applied: false, status: "needs_review", message: expect.stringContaining("duplicate_invoices") });
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: null });
  });

  it("links an invoice found by an incomplete search only as needs_review", async () => {
    allow();
    timeout();
    mocks.findInvoices.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockResolvedValue({ ...found, complete: false });
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(mocks.invoice).toMatchObject({ status: "needs_review", kiotviet_invoice_id: "8001" });
  });

  it("stores the duplicate-lookup metrics of the plan and the pre-POST re-check", async () => {
    allow();
    const metrics = { method: "index", freshness: "reused", localMs: 1.2, remoteMs: 0.4, totalMs: 1.6, apiCalls: 0, candidates: 0, indexLag: 0 };
    mocks.findInvoices.mockResolvedValue({ ...empty, metrics });
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(mocks.invoice?.reconciliation).toMatchObject({ duplicateLookup: metrics, prePostLookup: metrics });
  });
});

describe("Product-Only status: payment is informational, technical checks still decide", () => {
  const allow = () => Object.assign(mocks.orderSettings, { allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true });

  it("#1082 not inherited by KiotViet: created, with the unpaid balance recorded as KiotViet reports it", async () => {
    allow();
    mocks.invoiceDetail.mockResolvedValue(invoiceDetail(fixture, { totalPayment: 0, payments: [] }));
    const plan = await planInvoiceRecovery(ORDER_1082.orderId);
    expect(plan.action).toMatchObject({ kind: "create_invoice", input: { totalPayment: 0 } });
    await applyInvoiceRecovery(plan);
    expect(mocks.invoice).toMatchObject({ status: "created", reconciliation: expect.objectContaining({
      stockVerified: true,
      paymentVerification: expect.objectContaining({ status: "mismatch", invoiceTotalPayment: 0, remainingBalance: 202, kiotVietInvoiceFullyPaid: false }),
    }) });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("still needs_review when stock movement is unverified, whatever the payment says", async () => {
    allow();
    mocks.createInvoice.mockResolvedValue({ id: 8001, code: "HD8001" }); // stock did not move
    mocks.invoiceDetail.mockResolvedValue(invoiceDetail(fixture, { totalPayment: 0, payments: [] }));
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    const row = mocks.invoice as { status: string; last_error: string };
    expect(row.status).toBe("needs_review");
    expect(row.last_error).toMatch(/^invoice_verification_failed: .*stock_movement_unverified.*also informational payment differences/);
  });

  it("still needs_review when the invoice lines or identity do not match", async () => {
    allow();
    mocks.invoiceDetail.mockResolvedValue(invoiceDetail(fixture, { orderCode: "DH-OTHER" }));
    await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(mocks.invoice).toMatchObject({ status: "needs_review", reconciliation: expect.objectContaining({ checks: expect.objectContaining({ orderCode: false }) }) });
  });
});

describe("timeout recovery ownership", () => {
  it("never links a second invoice when the attempt was already settled by another worker", async () => {
    Object.assign(mocks.orderSettings, { allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true });
    mocks.createInvoice.mockImplementation(async () => {
      // While this POST is in doubt another worker already linked invoice 7000 to the row.
      Object.assign(mocks.invoice!, { kiotviet_invoice_id: "7000", kiotviet_invoice_code: "HD7000" });
      throw new UncertainResultError("timeout");
    });
    mocks.findInvoices.mockResolvedValueOnce({ invoices: [], complete: true }).mockResolvedValueOnce({ invoices: [], complete: true })
      .mockResolvedValue({ invoices: [{ id: 8001, code: "HD8001", orderCode: "DH031389", status: 1 }], complete: true });
    const result = await applyInvoiceRecovery(await planInvoiceRecovery(ORDER_1082.orderId));
    expect(result).toMatchObject({ applied: false, message: expect.stringContaining("already settled elsewhere") });
    expect(mocks.invoice).toMatchObject({ kiotviet_invoice_id: "7000" });
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
  });

  it("searches with bounded exponential backoff by default", async () => {
    const { uncertainPollDelays } = await import("@/lib/recovery/kiotviet-invoice-recovery");
    const saved = process.env.INVOICE_UNCERTAIN_POLL_MS;
    delete process.env.INVOICE_UNCERTAIN_POLL_MS;
    try {
      expect(uncertainPollDelays()).toEqual([1000, 2000, 4000, 8000]);
      process.env.INVOICE_UNCERTAIN_POLL_MS = "500,999999,-1,x";
      expect(uncertainPollDelays()).toEqual([500, 60000]);
    } finally {
      process.env.INVOICE_UNCERTAIN_POLL_MS = saved;
    }
  });
});
