import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getProduct: vi.fn(),
  archive: vi.fn(),
  collapse: vi.fn(),
  setGroup: vi.fn(),
  upsert: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietProduct: mocks.getProduct,
  getKiotVietVariantFamily: vi.fn(),
}));
vi.mock("@/lib/shopify/products", () => ({
  archiveShopifyProduct: mocks.archive,
  collapseShopifyVariantGroup: mocks.collapse,
  setShopifyVariantGroup: mocks.setGroup,
  createShopifyProduct: vi.fn(),
  findShopifyVariantsBySku: vi.fn(),
  shopifyProductHasCustomOptions: vi.fn(),
  updateShopifyProduct: vi.fn(),
}));
vi.mock("@/repositories/mappings", () => ({
  mappingsRepository: { findBySku: vi.fn(), upsert: mocks.upsert },
}));
vi.mock("@/lib/sync/inventory-sync", () => ({
  syncInventoryNotification: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { syncDeletedKiotVietProducts } from "@/lib/sync/kiotviet-product-sync";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.archive.mockResolvedValue(undefined);
  mocks.log.mockResolvedValue(undefined);
});

describe("KiotViet product deletion", () => {
  it("archives a normal mapped Shopify product", async () => {
    mocks.query
      .mockResolvedValueOnce([
        {
          shopify_product_id: "gid://shopify/Product/1",
          kiotviet_product_id: "501",
          sync_status: "synced",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await syncDeletedKiotVietProducts([{ id: 501, code: "NU012" }]);

    expect(mocks.archive).toHaveBeenCalledWith("gid://shopify/Product/1");
    expect(mocks.query.mock.calls[2][0]).toContain("sync_status='archived'");
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => statement.includes("kiotviet_product_id::text"))).toBe(true);
    expect(sql.some((statement) => statement.includes("$2::text[]"))).toBe(true);
    expect(sql.some((statement) => statement.includes("bigint"))).toBe(false);
  });

  it("is safe when the same delete webhook is processed again", async () => {
    let archived = false;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM product_mappings") && sql.includes("kiotviet_product_id::text=$1"))
        return [
          {
            shopify_product_id: "gid://shopify/Product/1",
            kiotviet_product_id: "501",
            sync_status: archived ? "archived" : "synced",
          },
        ];
      if (sql.includes("AND NOT")) return [];
      if (sql.includes("UPDATE product_mappings")) archived = true;
      return [];
    });

    await syncDeletedKiotVietProducts([501]);
    await syncDeletedKiotVietProducts([501]);

    expect(mocks.archive).toHaveBeenCalledTimes(1);
  });

  it("does not archive the Shopify product when another variant remains", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("kiotviet_product_id::text=$1"))
        return [
          {
            shopify_product_id: "gid://shopify/Product/1",
            kiotviet_product_id: "501",
            sync_status: "synced",
          },
        ];
      if (sql.includes("AND NOT"))
        return [{ kiotviet_product_id: "502" }];
      return [];
    });
    mocks.getProduct.mockResolvedValue({
      id: 502,
      code: "NU012-BLUE",
      name: "Remaining variant",
      inventories: [],
    });
    mocks.collapse.mockResolvedValue({
      id: "gid://shopify/ProductVariant/2",
      sku: "NU012-BLUE",
      product: { id: "gid://shopify/Product/1" },
      inventoryItem: { id: "gid://shopify/InventoryItem/2", tracked: true },
    });
    mocks.upsert.mockResolvedValue({});

    await syncDeletedKiotVietProducts([501]);

    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.collapse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 502 }),
      "gid://shopify/Product/1",
    );
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("kiotviet_product_id::text=ANY") &&
      String(sql).includes("$1::text[]") &&
      String(sql).includes("sync_status='archived'"),
    )).toBe(true);
  });
});
