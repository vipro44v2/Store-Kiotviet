import { beforeEach, expect, it, vi } from "vitest";
import type { KiotVietProduct } from "@/lib/kiotviet/types";
import type { MappingRecord } from "@/repositories/mappings";
import { MappingError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(), getFamily: vi.fn(), findBySku: vi.fn(), upsert: vi.fn(),
  getVariant: vi.fn(), findVariants: vi.fn(), create: vi.fn(), update: vi.fn(),
  collapse: vi.fn(), setGroup: vi.fn(), exists: vi.fn(), query: vi.fn(), log: vi.fn(),
}));
vi.mock("@/lib/kiotviet/products", () => ({ getKiotVietProduct: mocks.getProduct, getKiotVietVariantFamily: mocks.getFamily }));
vi.mock("@/repositories/mappings", () => ({ mappingsRepository: { findBySku: mocks.findBySku, upsertExact: mocks.upsert } }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/repositories/settings", () => ({ settingsRepository: { get: vi.fn() } }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: vi.fn() }));
vi.mock("@/lib/shopify/products", () => ({
  getShopifyVariant: mocks.getVariant, findShopifyVariantsBySku: mocks.findVariants,
  createShopifyProduct: mocks.create, updateShopifyProduct: mocks.update,
  collapseShopifyVariantGroup: mocks.collapse, setShopifyVariantGroup: mocks.setGroup,
  shopifyProductExists: mocks.exists, shopifyProductHasCustomOptions: vi.fn().mockResolvedValue(false),
}));
import { productSyncHash, syncKiotVietProductToShopify } from "@/lib/sync/kiotviet-product-sync";

const product: KiotVietProduct = {
  id: 2, code: "1206", name: "New B", basePrice: 250,
  inventories: [{ branchId: 1, branchName: "Main", onHand: 8 }],
};
const variant = { id: "v1", sku: "1206", product: { id: "p1", title: "Old A" }, inventoryItem: { id: "current-item", tracked: true } };
const archived: MappingRecord = {
  id: "old", sku: "1206", normalized_sku: "1206", kiotviet_product_id: "1", kiotviet_code: "1206",
  shopify_product_id: "old-p", shopify_variant_id: "old-v", shopify_inventory_item_id: "stale-item",
  sync_direction: "kiotviet_to_shopify", sync_status: "archived", last_sync_hash: "old-hash",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProduct.mockResolvedValue(product);
  mocks.getFamily.mockResolvedValue([product]);
  mocks.findBySku.mockResolvedValue([archived]);
  mocks.getVariant.mockResolvedValue(undefined);
  mocks.findVariants.mockResolvedValue([variant]);
  mocks.create.mockResolvedValue(variant);
  mocks.update.mockResolvedValue(variant);
  mocks.collapse.mockResolvedValue(variant);
  mocks.query.mockResolvedValue([]);
  mocks.exists.mockResolvedValue(true);
});

it("reclaims an archived SKU using the unique live identity and refreshes inventory", async () => {
  await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ updated: true });
  expect(mocks.getVariant).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith(product, variant, true, expect.any(Function), "ACTIVE");
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
    sku: "1206", normalized_sku: "1206", kiotviet_product_id: "2", kiotviet_code: "1206",
    shopify_product_id: "p1", shopify_variant_id: "v1", shopify_inventory_item_id: "current-item",
  }), { resetSyncHash: false });
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("sync_status<>'archived'"),
    ["1206", "2", await productSyncHash([product]), "v1"]);
  expect(mocks.log).toHaveBeenCalledWith("info", expect.any(String), expect.objectContaining({
    action: "sku_reclaimed", oldKiotVietProductId: "1", newKiotVietProductId: "2", sku: "1206",
    shopifyProductId: "p1", shopifyVariantId: "v1",
  }));
  expect(mocks.log).toHaveBeenCalledWith("info", expect.any(String), expect.objectContaining({ action: "archived_sku_mapping_ignored" }));
});

it("creates a product when only archived mappings remain and Shopify has no match", async () => {
  mocks.findVariants.mockResolvedValue([]);
  await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ updated: true });
  expect(mocks.create).toHaveBeenCalledWith(product, expect.any(Function), "ACTIVE");
  expect(mocks.getVariant).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each(["synced", "mapped", "pending", "failed"])("blocks another non-archived owner (%s)", async (sync_status) => {
  mocks.findBySku.mockResolvedValue([archived, { ...archived, id: "current", kiotviet_product_id: "3", sync_status }]);
  await expect(syncKiotVietProductToShopify(2)).rejects.toBeInstanceOf(MappingError);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it("rejects multiple exact Shopify matches before mutations", async () => {
  mocks.findVariants.mockResolvedValue([variant, { ...variant, id: "v2" }]);
  await expect(syncKiotVietProductToShopify(2)).rejects.toThrow(MappingError);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it("never treats an archived hash or blank-SKU checkpoint as current ownership", async () => {
  mocks.findBySku.mockResolvedValue([{ ...archived, last_sync_hash: await productSyncHash([product]) }]);
  mocks.getVariant.mockResolvedValue({ ...variant, sku: "" });
  await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ updated: true });
  expect(mocks.getVariant).not.toHaveBeenCalled();
  expect(mocks.findVariants).toHaveBeenCalledWith("1206");
});

it("does not repeat reclaim logs or metadata updates after B owns the SKU", async () => {
  mocks.findBySku.mockResolvedValue([archived, {
    ...archived, id: "new", kiotviet_product_id: "2", sync_status: "synced",
    shopify_product_id: "p1", shopify_variant_id: "v1", last_sync_hash: await productSyncHash([product]),
  }]);
  mocks.getVariant.mockResolvedValue(variant);
  await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ reason: "unchanged" });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.log.mock.calls.some((call) => call[2]?.action === "sku_reclaimed")).toBe(false);
  expect(mocks.log.mock.calls.some((call) => call[2]?.action === "archived_sku_mapping_ignored")).toBe(false);
});

function family() {
  const products = [
    { ...product, hasVariants: true, attributes: [{ attributeName: "Size", attributeValue: "S" }] },
    { ...product, id: 3, code: "1207", masterProductId: 2, attributes: [{ attributeName: "Size", attributeValue: "L" }] },
  ];
  mocks.getProduct.mockResolvedValue(products[0]);
  mocks.getFamily.mockResolvedValue(products);
  mocks.findBySku.mockImplementation(async (sku: string) => sku === "1206" ? [archived] : []);
  mocks.findVariants.mockImplementation(async (sku: string) => sku === "1206" ? [variant] : []);
  mocks.setGroup.mockResolvedValue({ productId: "p1", variants: [variant, { ...variant, id: "v2", sku: "1207" }] });
  return products;
}

it("reuses a unique Shopify family product while ignoring archived member ownership", async () => {
  const products = family();
  await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ updated: true, variants: 2 });
  expect(mocks.setGroup).toHaveBeenCalledWith(products, "p1", expect.objectContaining({ resumeFields: false, status: "ACTIVE" }));
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ kiotviet_product_id: "2", shopify_inventory_item_id: "current-item" }), expect.any(Object));
});

it("keeps active ownership conflicts blocked in a family", async () => {
  family();
  mocks.findBySku.mockResolvedValue([{ ...archived, sync_status: "synced" }]);
  await expect(syncKiotVietProductToShopify(2)).rejects.toThrow(MappingError);
  expect(mocks.setGroup).not.toHaveBeenCalled();
});

it("does not let an excluded old family member claim B's current SKU", async () => {
  const products = family();
  mocks.getFamily.mockResolvedValue([...products, { ...products[0], id: 1, isActive: false }]);
  mocks.findBySku.mockImplementation(async (sku: string) => sku === "1206" ? [archived, {
    ...archived, id: "new", kiotviet_product_id: "2", sync_status: "mapped", last_sync_hash: null,
    shopify_product_id: "p1", shopify_variant_id: "v1",
  }] : []);
  await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ updated: true, variants: 2 });
});

it("rejects duplicate Shopify SKUs within a family", async () => {
  family();
  mocks.findVariants.mockResolvedValue([variant, { ...variant, id: "duplicate" }]);
  await expect(syncKiotVietProductToShopify(2)).rejects.toThrow(MappingError);
  expect(mocks.setGroup).not.toHaveBeenCalled();
});

it("does not collapse or replace a reused Shopify product with unrelated active owners", async () => {
  mocks.query.mockResolvedValue([{ kiotviet_product_id: "999" }]);
  await expect(syncKiotVietProductToShopify(2)).rejects.toThrow("active mappings outside this KiotViet family");
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.collapse).not.toHaveBeenCalled();
});
