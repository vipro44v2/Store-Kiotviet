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
  archiveShopifyProduct: vi.fn(),
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
  mappingsRepository: { findBySku: mocks.findBySku, upsert: mocks.upsert },
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
