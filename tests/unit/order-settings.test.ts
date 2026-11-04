import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn(), surcharges: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth/middleware", () => ({
  requireAdmin: async () => undefined,
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
    const [sql, params] = m.query.mock.calls[0];
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
    expect(m.query).toHaveBeenCalledOnce();
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
