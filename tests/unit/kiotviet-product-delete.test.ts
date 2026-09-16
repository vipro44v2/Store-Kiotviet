import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsRepository } from "@/repositories/settings";
vi.mock("@/repositories/settings", () => ({ settingsRepository: { get: vi.fn().mockResolvedValue(undefined) } }));

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
  mappingsRepository: { findBySku: vi.fn(), upsertExact: mocks.upsert },
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
  it("never falls back to a reused SKU when a deleted ID has no mapping", async () => {
    mocks.query.mockResolvedValue([]);
    await syncDeletedKiotVietProducts([{ id: 999, code: "REUSED" }]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("requires an ID for code-only deletion when a SKU has been reused", async () => {
    mocks.query.mockResolvedValue([
      { shopify_product_id: "p1", kiotviet_product_id: "1", sync_status: "archived" },
      { shopify_product_id: "p1", kiotviet_product_id: "2", sync_status: "synced" },
    ]);
    await expect(syncDeletedKiotVietProducts([{ code: "REUSED" }])).rejects.toThrow("product ID required");
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("ignores code-only deletion if all matching owners are already archived", async () => {
    mocks.query.mockResolvedValue([
      { shopify_product_id: "p1", kiotviet_product_id: "1", sync_status: "archived" },
      { shopify_product_id: "p1", kiotviet_product_id: "2", sync_status: "archived" },
    ]);
    await syncDeletedKiotVietProducts([{ code: "REUSED" }]);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("archives a normal mapped Shopify product", async () => {
    vi.mocked(settingsRepository.get).mockResolvedValue({ categoryIds: [10] });
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
      inventories: [{ branchId: 10, branchName: "Main", onHand: 5 }],
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
      expect.any(Function),
      "ACTIVE",
    );
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("kiotviet_product_id::text=ANY") &&
      String(sql).includes("$1::text[]") &&
      String(sql).includes("sync_status='archived'"),
    )).toBe(true);
  });
});
