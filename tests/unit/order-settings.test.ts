import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn(), surcharges: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth/middleware", () => ({
  requireAdmin: async () => undefined,
  requireAdminUser: async () => "admin",
  adminApiErrorResponse: (error: unknown) => Response.json({ success: false, error: String(error) }, { status: 400 }),
}));
vi.mock("@/lib/security/csrf", () => ({ assertTrustedOrigin: () => undefined }));
vi.mock("@/lib/db/client", () => ({ query: m.query }));
vi.mock("@/lib/kiotviet/surcharges", () => ({ listKiotVietSurcharges: m.surcharges }));
vi.mock("@/lib/kiotviet/products", () => ({ getAllKiotVietCategories: async () => [] }));

import { ordersSettingsSchema } from "@/lib/settings/order-settings";
import { PUT } from "@/app/api/admin/settings/[key]/route";
import { SyncSettingsCard } from "@/components/admin/sync-settings";

const put = (body: unknown) => PUT(
  new Request("https://sync.example.com/api/admin/settings/orders", { method: "PUT", body: JSON.stringify(body) }),
  { params: Promise.resolve({ key: "orders" }) },
);

const savedOrders = () => m.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO system_settings(key,value,updated_at) VALUES('orders'")) as [string, string[]];
const audits = () => m.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO audit_logs"));
const productOnly = { invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD", productOnlyInvoicing: true };

beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockResolvedValue([]);
  m.surcharges.mockResolvedValue([{ id: 3, surchargeCode: "SHIP", surchargeName: "Phí vận chuyển" }]);
});

describe("orders settings schema", () => {
  it("accepts the Shopify Fulfilled trigger with a real currency while autoInvoice stays false", () => {
    expect(ordersSettingsSchema.parse({ autoInvoice: false, invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD" }))
      .toMatchObject({ autoInvoice: false, invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD" });
  });
  it.each([
    [{ invoiceCreationTrigger: "shopify_fulfilled" }, "currency is required"],
    [{ invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "usd" }, "Invalid"],
    [{ invoiceCreationTrigger: "on_delivery", kiotVietCurrency: "USD" }, "Invalid"],
    [{ shippingSurcharge: { id: "3", code: "SHIP" } }, "Invalid"],
    [{ shippingSurcharge: { id: 3, code: "SHIP", price: 10 } }, "Unrecognized"],
  ])("rejects %j", (value, message) => {
    expect(() => ordersSettingsSchema.parse(value)).toThrow(new RegExp(message, "i"));
  });
});

describe("PUT /api/admin/settings/orders", () => {
  it("saves the trigger and currency, keeps autoInvoice false and derives the activation time server-side", async () => {
    const response = await put({ autoInvoice: false, invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD", invoiceTriggerEnabledAt: "2020-01-01T00:00:00Z" });
    expect(response.status).toBe(200);
    const [sql, params] = savedOrders();
    expect(sql).toContain("jsonb_build_object('invoiceTriggerEnabledAt'");
    expect(JSON.parse(params[0])).toEqual({ autoInvoice: false, invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD" });
  });

  it("rejects the trigger without a currency", async () => {
    expect((await put({ invoiceCreationTrigger: "shopify_fulfilled" })).status).toBe(400);
    expect(m.query).not.toHaveBeenCalled();
  });

  it("accepts only a shipping surcharge that exists in KiotViet", async () => {
    expect((await put({ kiotVietCurrency: "USD", shippingSurcharge: { id: 3, code: "SHIP" } })).status).toBe(200);
    const missing = await put({ kiotVietCurrency: "USD", shippingSurcharge: { id: 4, code: "SHIP" } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: expect.stringContaining("was not found in GET /surchages") });
    expect(m.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO system_settings"))).toHaveLength(1);
  });
});

describe("Admin settings card", () => {
  it("shows the Shopify Fulfilled trigger, the currency and the shipping surcharge", () => {
    const html = renderToStaticMarkup(createElement(SyncSettingsCard, {
      stored: undefined,
      orders: { autoInvoice: false, invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD", shippingSurcharge: { id: 3, code: "SHIP" } },
    }));
    expect(html).toMatch(/<option value="shopify_fulfilled" selected="">/);
    expect(html).toContain('value="USD"');
    expect(html).toContain('value="3"');
    expect(html).toContain('value="SHIP"');
    expect(html).toContain("Phí vận chuyển Shopify → thu khác KiotViet");
  });
});

describe("Allow Unverified Prepayment Inheritance (admin validation)", () => {
  it.each([
    [{ ...productOnly, allowUnverifiedPrepaymentInheritance: true }, "explicit confirmation"],
    [{ invoiceCreationTrigger: "shopify_fulfilled", kiotVietCurrency: "USD", allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true }, "requires Product-Only"],
    [{ ...productOnly, prepaymentExceedsInvoicePolicy: "auto" }, "Invalid"],
  ])("rejects %j", async (value, message) => {
    expect(() => ordersSettingsSchema.parse(value)).toThrow(new RegExp(message, "i"));
    expect((await put(value)).status).toBe(400);
    expect(savedOrders()).toBeUndefined();
  });

  it("records who accepted the risk and when (server-side only) and audits the change", async () => {
    const response = await put({ ...productOnly, allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true,
      unverifiedPrepaymentAcceptedBy: "forged", unverifiedPrepaymentAcceptedAt: "2020-01-01T00:00:00Z" });
    expect(response.status).toBe(200);
    const saved = JSON.parse(savedOrders()[1][0]);
    expect(saved).toMatchObject({ allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true, unverifiedPrepaymentAcceptedBy: "admin" });
    expect(Date.parse(saved.unverifiedPrepaymentAcceptedAt)).toBeGreaterThan(Date.parse("2026-01-01"));
    expect(audits()).toHaveLength(1);
    expect(audits()[0][1]).toEqual(expect.arrayContaining(["admin", "unverified_prepayment_inheritance_enabled"]));
  });

  it("drops the confirmation when disabled, so enabling again asks for it again", async () => {
    m.query.mockImplementation(async (sql: string) => String(sql).startsWith("SELECT value FROM system_settings")
      ? [{ value: { ...productOnly, allowUnverifiedPrepaymentInheritance: true, acknowledgeUnverifiedPrepaymentRisk: true } }] : []);
    expect((await put({ ...productOnly, allowUnverifiedPrepaymentInheritance: false, acknowledgeUnverifiedPrepaymentRisk: true })).status).toBe(200);
    expect(JSON.parse(savedOrders()[1][0])).not.toHaveProperty("acknowledgeUnverifiedPrepaymentRisk");
    expect(audits()[0][1]).toContain("unverified_prepayment_inheritance_disabled");
  });

  it("is never enabled by default", () => {
    expect(ordersSettingsSchema.parse(productOnly)).not.toHaveProperty("allowUnverifiedPrepaymentInheritance");
  });
});
