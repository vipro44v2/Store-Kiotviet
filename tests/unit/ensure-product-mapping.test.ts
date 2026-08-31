import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBySku: vi.fn(),
  upsert: vi.fn(),
  findShopify: vi.fn(),
  getKiotViet: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/repositories/mappings", () => ({
  mappingsRepository: {
    findBySku: mocks.findBySku,
    upsert: mocks.upsert,
  },
}));
vi.mock("@/lib/shopify/products", () => ({
  findShopifyVariantsBySku: mocks.findShopify,
}));
vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietProducts: mocks.getKiotViet,
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { ensureProductMapping } from "@/lib/sync/ensure-product-mapping";

const shopifyVariant = (id: string, sku: string) => ({
  id,
  sku,
  product: { id: `product-${id}`, title: sku },
  inventoryItem: { id: `inventory-${id}`, tracked: true },
});
const mapping = {
  id: "mapping-1",
  sku: "NU012",
  normalized_sku: "NU012",
  shopify_product_id: "product-v1",
  shopify_variant_id: "v1",
  shopify_inventory_item_id: "inventory-v1",
  kiotviet_product_id: "501",
  kiotviet_code: "NU012",
  sync_direction: "kiotviet_to_shopify",
  sync_status: "mapped",
  last_sync_hash: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.mockResolvedValue(undefined);
});

describe("ensureProductMapping", () => {
  it("returns a valid existing mapping without API lookup", async () => {
    mocks.findBySku.mockResolvedValue([mapping]);

    await expect(ensureProductMapping("nu012")).resolves.toBe(mapping);

    expect(mocks.findShopify).not.toHaveBeenCalled();
    expect(mocks.getKiotViet).not.toHaveBeenCalled();
  });

  it("uses only one exact match and ignores fuzzy candidates", async () => {
    mocks.findBySku.mockResolvedValue([]);
    mocks.findShopify.mockResolvedValue([
      shopifyVariant("fuzzy", "NU012-X"),
      shopifyVariant("v1", " nu012 "),
    ]);
    mocks.getKiotViet.mockResolvedValue({
      total: 2,
      pageSize: 100,
      data: [
        { id: 999, code: "NU012-X", name: "Fuzzy" },
        { id: 501, code: "NU012", name: "Exact" },
      ],
    });
    mocks.upsert.mockResolvedValue(mapping);

    await expect(ensureProductMapping("NU012")).resolves.toMatchObject({
      kiotviet_product_id: "501",
    });

    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        normalized_sku: "NU012",
        shopify_variant_id: "v1",
        kiotviet_product_id: "501",
      }),
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "info",
      "Product mapping automatically created for order",
      expect.objectContaining({ action: "auto_map_order_product", sku: "NU012" }),
    );
  });

  it.each([
    [
      [shopifyVariant("fuzzy", "NU012-X")],
      [{ id: 501, code: "NU012", name: "Exact" }],
      "Shopify=0",
    ],
    [
      [shopifyVariant("v1", "NU012")],
      [],
      "KiotViet=0",
    ],
    [
      [shopifyVariant("v1", "NU012"), shopifyVariant("v2", "nu012")],
      [{ id: 501, code: "NU012", name: "Exact" }],
      "Shopify=2",
    ],
    [
      [shopifyVariant("v1", "NU012")],
      [
        { id: 501, code: "NU012", name: "Exact 1" },
        { id: 502, code: "nu012", name: "Exact 2" },
      ],
      "KiotViet=2",
    ],
  ])("rejects missing or duplicate exact matches", async (shopify, kiotViet, message) => {
    mocks.findBySku.mockResolvedValue([]);
    mocks.findShopify.mockResolvedValue(shopify);
    mocks.getKiotViet.mockResolvedValue({
      total: kiotViet.length,
      pageSize: 100,
      data: kiotViet,
    });

    await expect(ensureProductMapping("NU012")).rejects.toThrow(message);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not auto-select when multiple mappings already exist", async () => {
    mocks.findBySku.mockResolvedValue([mapping, { ...mapping, id: "mapping-2" }]);

    await expect(ensureProductMapping("NU012")).rejects.toThrow(
      "Multiple product mappings",
    );
    expect(mocks.findShopify).not.toHaveBeenCalled();
  });

  it("converges concurrent mapping attempts on one mapping", async () => {
    const stored: typeof mapping[] = [];
    mocks.findBySku.mockResolvedValue([]);
    mocks.findShopify.mockResolvedValue([shopifyVariant("v1", "NU012")]);
    mocks.getKiotViet.mockResolvedValue({
      total: 1,
      pageSize: 100,
      data: [{ id: 501, code: "NU012", name: "Exact" }],
    });
    mocks.upsert.mockImplementation(async () => {
      if (!stored.length) stored.push(mapping);
      return stored[0];
    });

    const results = await Promise.all([
      ensureProductMapping("NU012"),
      ensureProductMapping("NU012"),
    ]);

    expect(stored).toHaveLength(1);
    expect(results).toEqual([mapping, mapping]);
  });
});
