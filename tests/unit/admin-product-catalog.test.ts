import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProducts: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/kiotviet/products", () => ({ getKiotVietProducts: mocks.getProducts }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));

import { getAdminProductCatalogPage } from "@/lib/admin/product-catalog";
import { compactPageWindow } from "@/components/admin/product-sync-table";

describe("admin KiotViet product catalog", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.query.mockResolvedValue([]); });

  it("uses KiotViet pagination and total for catalogs over 2,000 products", async () => {
    mocks.getProducts.mockResolvedValue({
      total: 2143, pageSize: 40,
      data: [{ id: 81, code: "HAT-81", name: "Hat", categoryName: "Hats", basePrice: 100 }],
    });
    const result = await getAdminProductCatalogPage({ page: 3, pageSize: 40, search: "HAT", categoryId: 123 });
    expect(mocks.getProducts).toHaveBeenCalledWith(expect.objectContaining({
      currentItem: 80, pageSize: 40, searchTerm: "HAT", categoryId: 123,
    }));
    expect(result).toMatchObject({ total: 2143, totalPages: 54, page: 3 });
    expect(result.products).toHaveLength(1);
  });

  it("shows KiotViet products without mappings and never adds stale mapping rows", async () => {
    mocks.getProducts.mockResolvedValue({
      total: 1, pageSize: 40, data: [{ id: 9, code: "NEW", name: "New product" }],
    });
    mocks.query.mockResolvedValue([{ normalized_sku: "OLD", kiotviet_product_id: "1", shopify_product_id: "old", shopify_variant_id: "old-v", sync_status: "synced" }]);
    const result = await getAdminProductCatalogPage({ page: 1, pageSize: 40 });
    expect(result.products).toEqual([expect.objectContaining({ id: 9, syncStatus: "Not synced" })]);
  });

  it("joins mapping metadata in one batched query and marks ID mismatches stale", async () => {
    mocks.getProducts.mockResolvedValue({
      total: 2, pageSize: 40,
      data: [{ id: 9, code: " A ", name: "A" }, { id: 10, code: "B", name: "B" }],
    });
    mocks.query.mockResolvedValue([
      { normalized_sku: "A", kiotviet_product_id: "9", shopify_product_id: "p1", shopify_variant_id: "v1", sync_status: "synced" },
      { normalized_sku: "B", kiotviet_product_id: "999", shopify_product_id: "old", shopify_variant_id: "old-v", sync_status: "synced" },
    ]);
    const result = await getAdminProductCatalogPage({ page: 1, pageSize: 40 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("ANY($1::text[])"), [["A", "B"]]);
    expect(result.products.map((product) => product.syncStatus)).toEqual(["Synced", "Stale mapping"]);
  });

  it("supports an empty KiotViet catalog without querying mappings", async () => {
    mocks.getProducts.mockResolvedValue({ total: 0, pageSize: 40, data: [] });
    const result = await getAdminProductCatalogPage({ page: 1, pageSize: 40 });
    expect(result.products).toEqual([]);
    expect(result.total).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("propagates a KiotViet API failure", async () => {
    mocks.getProducts.mockRejectedValue(new Error("KiotViet unavailable"));
    await expect(getAdminProductCatalogPage({ page: 1, pageSize: 40 })).rejects.toThrow("KiotViet unavailable");
  });

  it("renders a compact page-number window", () => {
    expect(compactPageWindow(26, 54)).toEqual([1, "ellipsis", 24, 25, 26, 27, 28, "ellipsis", 54]);
    expect(compactPageWindow(1, 54)).toEqual([1, 2, 3, "ellipsis", 54]);
  });
});
