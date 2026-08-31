import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCategory: vi.fn(),
  find: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  query: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietCategory: mocks.getCategory,
}));
vi.mock("@/lib/shopify/collections", () => ({
  categoryCollectionHandle: (id: number) => `kiotviet-category-${id}`,
  findShopifyCollectionByHandle: mocks.find,
  getShopifyCollection: mocks.get,
  createShopifyManualCollection: mocks.create,
  updateShopifyCollectionTitle: mocks.update,
  publishShopifyCollectionToOnlineStore: mocks.publish,
}));
vi.mock("@/lib/db/client", () => ({
  transaction: (callback: (client: { query: typeof mocks.query }) => unknown) =>
    callback({ query: mocks.query }),
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { syncKiotVietCategoryToShopify } from "@/lib/sync/category-sync";

describe("category collection sync", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.log.mockResolvedValue(undefined);
    mocks.publish.mockResolvedValue(undefined);
  });
  it("recovers by deterministic handle before creating a collection", async () => {
    mocks.getCategory.mockResolvedValue({ id: 42, categoryName: "Shoes" });
    mocks.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.startsWith("SELECT shopify") ? { rows: [] } : { rows: [] },
      ),
    );
    mocks.find.mockResolvedValue({
      id: "gid://shopify/Collection/1",
      title: "Shoes",
      handle: "kiotviet-category-42",
    });
    await syncKiotVietCategoryToShopify(42);
    expect(mocks.find).toHaveBeenCalledWith("kiotviet-category-42");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith("gid://shopify/Collection/1");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO category_mappings"),
      expect.arrayContaining([42, "Shoes", "gid://shopify/Collection/1"]),
    );
  });
  it("updates only the collection title when the category name changes", async () => {
    mocks.getCategory.mockResolvedValue({ id: 42, categoryName: "New Shoes" });
    mocks.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.startsWith("SELECT shopify")
          ? {
              rows: [
                {
                  shopify_collection_id: "gid://shopify/Collection/1",
                  category_name: "Shoes",
                },
              ],
            }
          : { rows: [] },
      ),
    );
    mocks.get.mockResolvedValue({
      id: "gid://shopify/Collection/1",
      title: "Shoes",
      handle: "kiotviet-category-42",
    });
    mocks.update.mockResolvedValue({
      id: "gid://shopify/Collection/1",
      title: "New Shoes",
      handle: "kiotviet-category-42",
    });
    await syncKiotVietCategoryToShopify(42);
    expect(mocks.update).toHaveBeenCalledWith(
      "gid://shopify/Collection/1",
      "New Shoes",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("recreates and remaps a collection deleted on Shopify", async () => {
    mocks.getCategory.mockResolvedValue({ id: 42, categoryName: "Shoes" });
    mocks.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.startsWith("SELECT shopify")
          ? {
              rows: [
                {
                  shopify_collection_id: "gid://shopify/Collection/deleted",
                  category_name: "Shoes",
                },
              ],
            }
          : { rows: [] },
      ),
    );
    mocks.get.mockResolvedValue(null);
    mocks.find.mockResolvedValue(null);
    mocks.create.mockResolvedValue({
      id: "gid://shopify/Collection/new",
      title: "Shoes",
      handle: "kiotviet-category-42",
    });
    await syncKiotVietCategoryToShopify(42);
    expect(mocks.create).toHaveBeenCalledWith("Shoes", "kiotviet-category-42");
    expect(mocks.publish).toHaveBeenCalledWith("gid://shopify/Collection/new");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO category_mappings"),
      expect.arrayContaining(["gid://shopify/Collection/new"]),
    );
  });
});
