import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  ensureMapping: vi.fn(),
  resolveBranch: vi.fn(),
  createOrder: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  transaction: (callback: (client: { query: typeof mocks.query }) => unknown) =>
    callback({ query: mocks.query }),
}));
vi.mock("@/lib/sync/ensure-product-mapping", () => ({
  ensureProductMapping: mocks.ensureMapping,
}));
vi.mock("@/lib/sync/default-branch", () => ({
  resolveDefaultBranchId: mocks.resolveBranch,
}));
vi.mock("@/lib/kiotviet/orders", () => ({
  createKiotVietOrder: mocks.createOrder,
  cancelKiotVietOrder: vi.fn(),
  findKiotVietOrderByShopifyReference: vi.fn(),
  updateKiotVietOrderCustomer: vi.fn(),
}));
vi.mock("@/lib/sync/customer-sync", () => ({ syncShopifyCustomer: vi.fn() }));
vi.mock("@/lib/shopify/orders", () => ({
  cancelShopifyOrderById: vi.fn(),
  fulfillShopifyOrderById: vi.fn(),
}));

import { syncShopifyOrder } from "@/lib/sync/order-sync";

describe("Shopify order product auto-mapping", () => {
  it("continues order creation with the auto-mapped KiotViet product ID", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM order_mappings"))
        return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT value FROM system_settings"))
        return { rows: [{ value: { paidOnly: true } }], rowCount: 1 };
      if (sql.includes("SELECT kiotviet_order_id"))
        return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    mocks.resolveBranch.mockResolvedValue(10);
    mocks.ensureMapping.mockResolvedValue({ kiotviet_product_id: "501" });
    mocks.createOrder.mockResolvedValue({ id: 700, code: "DH700" });

    await syncShopifyOrder({
      id: 100,
      name: "#100",
      created_at: "2026-01-01T00:00:00Z",
      financial_status: "paid",
      total_price: "120",
      line_items: [
        { id: 1, sku: "NU012", quantity: 2, price: "60", name: "Product" },
      ],
    });

    expect(mocks.ensureMapping).toHaveBeenCalledWith("NU012");
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderDetails: [expect.objectContaining({ productId: 501 })],
      }),
    );
  });
});
