import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/repositories/settings", () => ({ settingsRepository: { get: vi.fn().mockResolvedValue(undefined) } }));
import type { KiotVietProduct } from "@/lib/kiotviet/types";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), findBySku: vi.fn(), upsert: vi.fn(), query: vi.fn(),
  create: vi.fn(), update: vi.fn(), getVariant: vi.fn(), findVariants: vi.fn(),
  setGroup: vi.fn(), exists: vi.fn(), customOptions: vi.fn(),
  getInventory: vi.fn(), setInventory: vi.fn(), log: vi.fn(),
}));
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietFetch: mocks.fetch }));
vi.mock("@/repositories/mappings", () => ({
  mappingsRepository: { findBySku: mocks.findBySku, upsertExact: mocks.upsert },
}));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/shopify/products", () => ({
  createShopifyProduct: mocks.create, updateShopifyProduct: mocks.update,
  getShopifyVariant: mocks.getVariant, findShopifyVariantsBySku: mocks.findVariants,
  setShopifyVariantGroup: mocks.setGroup, shopifyProductExists: mocks.exists,
  shopifyProductHasCustomOptions: mocks.customOptions,
  archiveShopifyProduct: vi.fn(), collapseShopifyVariantGroup: vi.fn(),
}));
vi.mock("@/lib/shopify/inventory", () => ({
  getShopifyInventory: async () => ({ isActive: true, available: await mocks.getInventory(), onHand: 0 }),
  ensureShopifyInventoryActive: async () => ({ isActive: true, available: await mocks.getInventory(), onHand: 0 }), setShopifyInventory: mocks.setInventory,
}));
vi.mock("@/lib/shopify/locations", () => ({ getActiveShopifyLocations: vi.fn() }));

import { getKiotVietProduct, getKiotVietVariantFamily } from "@/lib/kiotviet/products";
import { syncKiotVietProductToShopify } from "@/lib/sync/kiotviet-product-sync";

const inventory = { branchId: 10, branchName: "Main", onHand: 12.8, reserved: 3 };
const product: KiotVietProduct = {
  id: 501, code: "SKU-1", name: "Product", inventories: [inventory],
};
const saved = {
  id: "variant-1", sku: "SKU-1", product: { id: "product-1" },
  inventoryItem: { id: "inventory-1" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetch.mockResolvedValue(product);
  mocks.findVariants.mockResolvedValue([]);
  mocks.create.mockResolvedValue(saved);
  mocks.update.mockResolvedValue(saved);
  mocks.getInventory.mockResolvedValue(0);
  mocks.setInventory.mockImplementation(async (_item, _location, quantity) => { mocks.getInventory.mockResolvedValueOnce(quantity); return {}; });
  mocks.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM branch_location_mappings")
      ? [{ shopify_location_id: "location-10", safety_stock: "2" }]
      : [],
  );
  mocks.findBySku.mockResolvedValue([]);
  mocks.upsert.mockImplementation(async () => {
    mocks.findBySku.mockResolvedValue([{
      shopify_inventory_item_id: "inventory-1", shopify_variant_id: saved.id,
      shopify_product_id: saved.product.id,
    }]);
  });
});

describe("KiotViet inventory hydration", () => {
  it("keeps inventory from the detail endpoint without another request", async () => {
    await expect(getKiotVietProduct(501)).resolves.toEqual(product);
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith("/products/501");
  });

  it.each([undefined, []])("hydrates missing/empty detail inventory using the supported list query (%j)", async (inventories) => {
    mocks.fetch.mockResolvedValueOnce({ ...product, inventories })
      .mockResolvedValueOnce({ data: [{ ...product, name: "List name" }], total: 1, pageSize: 100 });
    await expect(getKiotVietProduct(501)).resolves.toEqual(product);
    const url = new URL(mocks.fetch.mock.calls[1][0], "https://public.kiotapi.com");
    expect(url.searchParams.get("includeInventory")).toBe("true");
    expect(url.searchParams.get("name")).toBe(product.code);
  });

  it("paginates and never adopts inventory from a different ID with the same SKU/title", async () => {
    mocks.fetch.mockResolvedValueOnce({ ...product, inventories: undefined })
      .mockResolvedValueOnce({ data: [{ ...product, id: 999 }], total: 2, pageSize: 1 })
      .mockResolvedValueOnce({ data: [product], total: 2, pageSize: 1 });
    await expect(getKiotVietProduct(501)).resolves.toEqual(product);
    expect(mocks.fetch.mock.calls[2][0]).toContain("currentItem=1");
  });

  it.each([undefined, []])("preserves family-fetched inventories with an unenriched trigger (%j)", async (inventories) => {
    const trigger = { ...product, hasVariants: true, inventories, basePrice: 42 };
    mocks.fetch.mockResolvedValue({ data: [product], total: 1, pageSize: 100 });
    await expect(getKiotVietVariantFamily(trigger)).resolves.toEqual([
      { ...trigger, inventories: product.inventories },
    ]);
  });

  it("keeps populated trigger inventory, including zero stock", async () => {
    const trigger = { ...product, hasVariants: true, inventories: [{ ...inventory, onHand: 0 }] };
    mocks.fetch.mockResolvedValue({ data: [product], total: 1, pageSize: 100 });
    await expect(getKiotVietVariantFamily(trigger)).resolves.toEqual([trigger]);
  });
});

describe("product-to-inventory sync", () => {
  it("syncs enriched family rows and reconciles every variant on an unchanged retry", async () => {
    const trigger = { ...product, hasVariants: true, inventories: undefined };
    const sibling = { ...product, id: 502, code: "SKU-2", masterProductId: 501 };
    mocks.fetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/products/501") return trigger;
      if (endpoint.includes("masterProductId=501"))
        return { data: [{ ...product, hasVariants: true }, sibling], total: 2, pageSize: 100 };
      return { data: [], total: 0, pageSize: 100 };
    });
    const siblingSaved = { ...saved, id: "variant-2", sku: "SKU-2", inventoryItem: { id: "inventory-2" } };
    mocks.setGroup.mockResolvedValue({ productId: saved.product.id, variants: [saved, siblingSaved] });
    const mappings = new Map<string, Record<string, unknown>>();
    mocks.findBySku.mockImplementation(async (sku: string) => mappings.has(sku) ? [mappings.get(sku)] : []);
    mocks.upsert.mockImplementation(async (mapping: Record<string, unknown>) => {
      mappings.set(String(mapping.normalized_sku), mapping);
    });
    await syncKiotVietProductToShopify(501);
    expect(mocks.setInventory).toHaveBeenCalledWith("inventory-1", "location-10", 10, 0);
    expect(mocks.setInventory).toHaveBeenCalledWith("inventory-2", "location-10", 10, 0);
    const hash = mocks.query.mock.calls.find(([sql]) => sql.includes("last_sync_hash=$3"))![1][2];
    for (const mapping of mappings.values()) mapping.last_sync_hash = hash;
    mocks.exists.mockResolvedValue(true);
    mocks.setInventory.mockClear();
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ reason: "unchanged" });
    expect(mocks.setGroup).toHaveBeenCalledTimes(1);
    expect(mocks.setInventory).toHaveBeenCalledTimes(2);
  });

  it("creates a simple product and sets stock using OnHand, safety stock and flooring", async () => {
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ updated: true });
    expect(mocks.setInventory).toHaveBeenCalledWith("inventory-1", "location-10", 10, 0);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE kiotviet_branch_id=$1"), [10]);
  });

  it.each([
    { reserved: undefined, actualReserved: 4, expected: 10 },
    { reserved: 0, actualReserved: 4, expected: 10 },
    { reserved: 20, actualReserved: 4, expected: 10 },
  ])("ignores both reserved and actualReserved when calculating stock: %j", async ({ expected, ...reservations }) => {
    mocks.fetch.mockResolvedValue({ ...product, inventories: [{ ...inventory, ...reservations }] });
    mocks.getInventory.mockResolvedValue(99);
    await syncKiotVietProductToShopify(501);
    expect(mocks.setInventory).toHaveBeenCalledWith("inventory-1", "location-10", expected, 99);
  });

  it("updates an existing product and reconciles inventory", async () => {
    mocks.findVariants.mockResolvedValue([saved]);
    await syncKiotVietProductToShopify(501);
    expect(mocks.update).toHaveBeenCalled();
    expect(mocks.setInventory).toHaveBeenCalledWith("inventory-1", "location-10", 10, 0);
  });

  it.each([undefined, []])("logs and rejects unavailable inventory instead of silently succeeding (%j)", async (inventories) => {
    mocks.fetch.mockResolvedValueOnce({ ...product, inventories })
      .mockResolvedValueOnce({ data: [], total: 0, pageSize: 100 });
    await expect(syncKiotVietProductToShopify(501, "job-1")).rejects.toThrow("has no inventory rows");
    expect(mocks.log).toHaveBeenCalledWith("warn", expect.stringContaining("stock was not reconciled"),
      expect.objectContaining({ kiotVietProductId: 501, sku: "SKU-1", jobId: "job-1" }));
    expect(mocks.setInventory).not.toHaveBeenCalled();
  });

  it("reconciles stock when product metadata is unchanged", async () => {
    await syncKiotVietProductToShopify(501);
    const hash = mocks.query.mock.calls.find(([sql]) => sql.includes("last_sync_hash=$3"))![1][2];
    mocks.findBySku.mockResolvedValue([{
      shopify_inventory_item_id: "inventory-1", shopify_variant_id: saved.id,
      last_sync_hash: hash,
    }]);
    mocks.getVariant.mockResolvedValue(saved);
    mocks.setInventory.mockClear();
    await expect(syncKiotVietProductToShopify(501)).resolves.toMatchObject({ reason: "unchanged" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.setInventory).toHaveBeenCalledWith("inventory-1", "location-10", 10, 0);
  });

  it("does not hide missing inventory behind the unchanged-product shortcut", async () => {
    await syncKiotVietProductToShopify(501);
    const hash = mocks.query.mock.calls.find(([sql]) => sql.includes("last_sync_hash=$3"))![1][2];
    mocks.findBySku.mockResolvedValue([{ shopify_variant_id: saved.id, last_sync_hash: hash }]);
    mocks.getVariant.mockResolvedValue(saved);
    mocks.fetch.mockResolvedValueOnce({ ...product, inventories: [] })
      .mockResolvedValueOnce({ data: [], total: 0, pageSize: 100 });
    await expect(syncKiotVietProductToShopify(501)).rejects.toThrow("has no inventory rows");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith("warn", expect.any(String), expect.objectContaining({ sku: product.code }));
  });
});
