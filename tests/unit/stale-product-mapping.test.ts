import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getFamily: vi.fn(),
  getVariant: vi.fn(),
  findVariants: vi.fn(),
  createProduct: vi.fn(),
  customOptions: vi.fn(),
  updateProduct: vi.fn(),
  collapseGroup: vi.fn(),
  setGroup: vi.fn(),
  archiveProduct: vi.fn(),
  productExists: vi.fn(),
  findBySku: vi.fn(),
  upsert: vi.fn(),
  query: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietProduct: mocks.getProduct,
  getKiotVietVariantFamily: mocks.getFamily,
}));
vi.mock("@/lib/shopify/products", () => ({
  archiveShopifyProduct: mocks.archiveProduct,
  collapseShopifyVariantGroup: mocks.collapseGroup,
  createShopifyProduct: mocks.createProduct,
  findShopifyVariantsBySku: mocks.findVariants,
  getShopifyVariant: mocks.getVariant,
  setShopifyVariantGroup: mocks.setGroup,
  shopifyProductExists: mocks.productExists,
  shopifyProductHasCustomOptions: mocks.customOptions,
  updateShopifyProduct: mocks.updateProduct,
}));
vi.mock("@/repositories/mappings", () => ({
  mappingsRepository: { findBySku: mocks.findBySku, upsertExact: mocks.upsert },
}));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: vi.fn() }));

import {
  resolveExistingFamilyShopifyProduct,
  syncKiotVietProductToShopify,
} from "@/lib/sync/kiotviet-product-sync";

describe("stale Shopify product mapping recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const product = { id: 501, code: "SKU-1", name: "Product", inventories: [] };
    mocks.getProduct.mockResolvedValue(product);
    mocks.getFamily.mockResolvedValue([product]);
    mocks.findBySku.mockResolvedValue([{
      normalized_sku: "SKU-1",
      shopify_product_id: "gid://shopify/Product/deleted",
      shopify_variant_id: "gid://shopify/ProductVariant/deleted",
      shopify_inventory_item_id: "gid://shopify/InventoryItem/deleted",
      last_sync_hash: "old",
      sync_status: "synced",
    }]);
    mocks.getVariant.mockResolvedValue(undefined);
    mocks.findVariants.mockResolvedValue([]);
    mocks.createProduct.mockResolvedValue({
      id: "gid://shopify/ProductVariant/new",
      sku: "SKU-1",
      product: { id: "gid://shopify/Product/new", title: "Product" },
      inventoryItem: { id: "gid://shopify/InventoryItem/new", tracked: true },
    });
    mocks.upsert.mockResolvedValue({});
    mocks.query.mockResolvedValue([]);
    mocks.log.mockResolvedValue(undefined);
  });

  it("recreates a deleted Shopify product and updates the existing mapping", async () => {
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ updated: true });
    expect(mocks.createProduct).toHaveBeenCalledWith(expect.objectContaining({ id: 501 }));
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      kiotviet_product_id: "501",
      shopify_product_id: "gid://shopify/Product/new",
      shopify_variant_id: "gid://shopify/ProductVariant/new",
      sync_direction: "kiotviet_to_shopify",
    }));
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("kiotviet_product_id::text=$2"),
      expect.arrayContaining(["SKU-1", "501", expect.any(String), "gid://shopify/ProductVariant/new"]),
    );
  });

  it("does not create or normally update an inactive simple product", async () => {
    const inactive = { id: 501, code: "SKU-1", name: "Inactive", isActive: false, inventories: [] };
    mocks.getProduct.mockResolvedValue(inactive);
    mocks.getFamily.mockResolvedValue([inactive]);
    mocks.query.mockResolvedValue([]);
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ reason: "inactive" });
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.setGroup).not.toHaveBeenCalled();
  });

  it("does not create or normally update an unsaleable simple product", async () => {
    const unsaleable = { id: 501, code: "SKU-1", name: "Unsaleable", allowsSale: false, inventories: [] };
    mocks.getProduct.mockResolvedValue(unsaleable);
    mocks.getFamily.mockResolvedValue([unsaleable]);
    mocks.query.mockResolvedValue([]);
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ reason: "inactive" });
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.updateProduct).not.toHaveBeenCalled();
  });

  it("rebuilds valid siblings without archiving the whole Shopify product", async () => {
    const inactive = { id: 501, code: "OLD", name: "Old", isActive: false, masterProductId: 500, inventories: [] };
    const active = { id: 502, code: "LIVE", name: "Live", masterProductId: 500, attributes: [{ attributeName: "Color", attributeValue: "Blue" }], inventories: [] };
    mocks.getProduct.mockResolvedValue(inactive);
    mocks.getFamily.mockResolvedValue([inactive, active]);
    mocks.findBySku.mockResolvedValue([]);
    mocks.createProduct.mockResolvedValue({
      id: "variant-live", sku: "LIVE",
      product: { id: "product-live", title: "Live" },
      inventoryItem: { id: "inventory-live", tracked: true },
    });
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ updated: true });
    expect(mocks.createProduct).toHaveBeenCalledWith(active);
    expect(mocks.archiveProduct).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("sync_status='archived'"),
      [["501"]],
    );
  });

  it("recreates a family when two mapped Shopify products are both deleted", async () => {
    mocks.productExists.mockResolvedValue(false);
    await expect(
      resolveExistingFamilyShopifyProduct(["deleted-1", "deleted-2"]),
    ).resolves.toBeUndefined();
  });

  it("uses the existing product when the other family mapping is stale", async () => {
    mocks.productExists.mockImplementation(async (id: string) => id === "existing");
    await expect(
      resolveExistingFamilyShopifyProduct(["deleted", "existing"]),
    ).resolves.toBe("existing");
  });

  it("rejects a family mapped to two existing Shopify products", async () => {
    mocks.productExists.mockResolvedValue(true);
    await expect(
      resolveExistingFamilyShopifyProduct(["existing-1", "existing-2"]),
    ).rejects.toThrow("multiple existing Shopify products");
  });
});
