import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shopify: vi.fn(), kiotviet: vi.fn(), listAll: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/shopify/products", () => ({ getShopifyVariants: mocks.shopify }));
vi.mock("@/lib/kiotviet/products", () => ({ getKiotVietProducts: mocks.kiotviet }));
vi.mock("@/repositories/mappings", () => ({ mappingsRepository: { listAll: mocks.listAll, upsert: mocks.upsert } }));
import { runMappingBackfill } from "@/lib/sync/mapping-backfill";

const variant = { id: "v1", sku: " NU010 ", product: { id: "p1", title: "P" }, inventoryItem: { id: "i1", tracked: true } };
const product = { id: 501, code: "nu010", name: "P" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopify.mockResolvedValue({ productVariants: { nodes: [variant], pageInfo: { hasNextPage: false } } });
  mocks.kiotviet.mockResolvedValue({ data: [product], total: 1, pageSize: 100 });
  mocks.listAll.mockResolvedValue([]);
  mocks.upsert.mockResolvedValue({});
});

describe("mapping backfill", () => {
  it("is a dry-run by default", async () => {
    await expect(runMappingBackfill()).resolves.toMatchObject({ dryRun: true, newMappings: 1 });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.kiotviet).toHaveBeenCalledWith(expect.not.objectContaining({ searchTerm: expect.anything() }));
  });
  it("applies exact mappings and is idempotent with an existing valid mapping", async () => {
    await runMappingBackfill({ apply: true });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ normalized_sku: "NU010", kiotviet_product_id: "501" }));
    mocks.listAll.mockResolvedValue([{ id: "m1", sku: "NU010", normalized_sku: "NU010", shopify_product_id: "p1", shopify_variant_id: "v1", shopify_inventory_item_id: "i1", kiotviet_product_id: "501", kiotviet_code: "nu010", sync_direction: "kiotviet_to_shopify", sync_status: "mapped", last_sync_hash: null }]);
    await expect(runMappingBackfill({ apply: true })).resolves.toMatchObject({ alreadyMapped: 1, newMappings: 0 });
  });
});
