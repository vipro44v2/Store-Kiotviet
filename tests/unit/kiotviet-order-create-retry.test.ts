import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/kiotviet/auth", () => ({
  getKiotVietAccessToken: vi.fn(async () => "token"),
  clearKiotVietAccessToken: vi.fn(async () => undefined),
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ KIOTVIET_RETAILER: "shop" }) }));

import { createKiotVietOrder } from "@/lib/kiotviet/orders";
import { kiotVietClient } from "@/lib/kiotviet/client";
import { createKiotVietInvoice, findKiotVietInvoicesForOrder } from "@/lib/kiotviet/invoices";
import { ApiError, RetryableError, UncertainResultError } from "@/lib/errors";

const input = {
  branchId: 1, description: "Shopify #1 (1)", discount: 0, method: "Transfer",
  totalPayment: 0, makeInvoice: false,
  orderDetails: [{ productId: 1, productCode: "A", productName: "A", quantity: 1, price: 1 }],
};
const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("KiotViet order creation after uncertain responses", () => {
  it("does not resend after a network failure or timeout", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(createKiotVietOrder(input)).rejects.toBeInstanceOf(UncertainResultError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not resend after a 5xx response", async () => {
    fetchMock.mockResolvedValue(json(503, { message: "busy" }));
    const error = await createKiotVietOrder(input).catch((e) => e);
    expect(error).toBeInstanceOf(UncertainResultError);
    expect(error).toBeInstanceOf(RetryableError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats a success without an order ID as uncertain", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await expect(createKiotVietOrder(input)).rejects.toBeInstanceOf(UncertainResultError);
  });

  it("reports a definite 4xx rejection as ApiError", async () => {
    fetchMock.mockResolvedValue(json(400, { responseStatus: { message: "Invalid product" } }));
    await expect(createKiotVietOrder(input)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still retries a rejected 401 after refreshing the token", async () => {
    fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { id: 7, code: "DH7" }));
    await expect(createKiotVietOrder(input)).resolves.toEqual({ id: 7, code: "DH7" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying idempotent reads as before", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json(200, { data: [] }));
    await expect(kiotVietClient.get("/orders")).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("006 sync direction migration", () => {
  const sql = readFileSync(path.join(process.cwd(), "database/migrations/006_sync_direction_settings.sql"), "utf8");
  it("is additive and never deletes or rewrites existing rows", () => {
    expect(sql).not.toMatch(/DELETE FROM|DROP TABLE|DROP COLUMN|TRUNCATE|UPDATE order_mappings|UPDATE inventory_snapshots/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/);
  });
  it("lets stored synchronization keys win over the defaults", () => {
    expect(sql).toContain("SET value = EXCLUDED.value || system_settings.value");
  });
  it("disables reverse order status only for new installations", () => {
    expect(sql).toContain("'kiotVietOrderStatusToShopify', existing_installation");
    expect(sql).toContain("'shopifyOrdersToKiotViet', true");
    expect(sql).toContain("'kiotVietInventoryToShopify', true");
  });
});

describe("KiotViet invoice API", () => {
  const invoiceInput = {
    branchId: 10, orderId: 5555, discount: 0, totalPayment: 0, method: "Transfer",
    invoiceDetails: [{ productId: 1, productCode: "377", productName: "377", quantity: 1, price: 20, discount: 0 }],
  };

  it("never resends POST /invoices after a timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    await expect(createKiotVietInvoice(invoiceInput)).rejects.toBeInstanceOf(UncertainResultError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/invoices");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ orderId: 5555, branchId: 10 });
  });

  it("matches invoices by orderCode and confirms absence only after a full scan", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { total: 1, pageSize: 100, data: [{ id: 1, code: "HD1", orderCode: "OTHER", status: 1 }] }))
      .mockResolvedValueOnce(json(200, { total: 2, pageSize: 100, data: [
        { id: 2, code: "HD2", orderCode: "DH1072", status: 1 }, { id: 3, code: "HD3", orderCode: "DH9", status: 1 },
      ] }));
    await expect(findKiotVietInvoicesForOrder({ id: 5555, code: "DH1072" }, new Date("2026-10-29T00:00:00Z")))
      .resolves.toEqual({ invoices: [{ id: 2, code: "HD2", orderCode: "DH1072", status: 1 }], complete: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("orderId=5555");
    expect(String(fetchMock.mock.calls[1][0])).toContain("fromPurchaseDate=2026-10-29");
  });

  it("reports an incomplete lookup when the scan cannot finish", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { total: 0, pageSize: 100, data: [] }))
      .mockResolvedValueOnce(json(200, { total: 500, pageSize: 100, data: [] }));
    await expect(findKiotVietInvoicesForOrder({ id: 5555, code: "DH1072" }, new Date())).resolves.toMatchObject({ complete: false });
  });
});

describe("007 invoice migration", () => {
  const sql = readFileSync(path.join(process.cwd(), "database/migrations/007_kiotviet_invoices.sql"), "utf8");
  it("is additive and keeps one invoice per Shopify order, KiotViet order and KiotViet invoice", () => {
    expect(sql).not.toMatch(/DELETE FROM|DROP TABLE|DROP COLUMN|TRUNCATE/i);
    expect(sql).toMatch(/shopify_order_id text NOT NULL UNIQUE/);
    expect(sql).toMatch(/kiotviet_order_id bigint UNIQUE/);
    expect(sql).toMatch(/kiotviet_invoice_id bigint UNIQUE/);
  });
  it("defaults Auto Invoice to off without overwriting a stored value", () => {
    expect(sql).toContain("jsonb_build_object('autoInvoice', false) || value");
    expect(sql).toContain("NOT (value ? 'autoInvoice')");
  });
});
