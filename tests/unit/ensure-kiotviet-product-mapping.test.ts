import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  findShopify: vi.fn(),
  findBySku: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@/lib/kiotviet/products", () => ({ getKiotVietProduct: mocks.getProduct }));
vi.mock("@/lib/shopify/products", () => ({ findShopifyVariantsBySku: mocks.findShopify }));
vi.mock("@/repositories/mappings", () => ({
  mappingsRepository: { findBySku: mocks.findBySku, upsert: mocks.upsert },
}));

import { ensureKiotVietProductMapping } from "@/lib/sync/ensure-kiotviet-product-mapping";

const variant = (id: string, sku: string) => ({
  id,
  sku,
  product: { id: `product-${id}`, title: "Product" },
  inventoryItem: { id: `inventory-${id}`, tracked: true },
});
const mapping = {
  id: "mapping-1", sku: "NU010", normalized_sku: "NU010",
  shopify_product_id: "product-v1", shopify_variant_id: "v1",
  shopify_inventory_item_id: "inventory-v1", kiotviet_product_id: "501",
  kiotviet_code: "NU010", sync_direction: "kiotviet_to_shopify",
  sync_status: "mapped", last_sync_hash: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProduct.mockResolvedValue({ id: 501, code: " nu010 ", name: "Product" });
  mocks.findBySku.mockResolvedValueOnce([]).mockResolvedValueOnce([mapping]);
  mocks.upsert.mockResolvedValue(mapping);
});

describe("ensure KiotViet product mapping", () => {
  it("creates an exact normalized SKU mapping", async () => {
    mocks.findShopify.mockResolvedValue([variant("fuzzy", "NU010-X"), variant("v1", "nu010")]);
    await expect(ensureKiotVietProductMapping("501")).resolves.toMatchObject({ status: "mapped", sku: "NU010" });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      normalized_sku: "NU010",
      kiotviet_product_id: "501",
      shopify_variant_id: "v1",
      shopify_inventory_item_id: "inventory-v1",
    }));
  });

  it("reports zero Shopify matches without writing", async () => {
    mocks.findShopify.mockResolvedValue([variant("fuzzy", "NU010-X")]);
    await expect(ensureKiotVietProductMapping("501")).resolves.toMatchObject({ status: "missing_shopify", matches: 0 });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("reports duplicate exact Shopify matches without writing", async () => {
    mocks.findShopify.mockResolvedValue([variant("v1", "NU010"), variant("v2", "nu010")]);
    await expect(ensureKiotVietProductMapping("501")).resolves.toMatchObject({ status: "duplicate_shopify", matches: 2 });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
