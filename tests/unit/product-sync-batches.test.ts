import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), getProducts: vi.fn(), getProduct: vi.fn() }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietProducts: mocks.getProducts,
  getKiotVietProduct: mocks.getProduct,
}));

import {
  dedupeKiotVietSyncProducts,
  enqueueKiotVietProductSyncJobs,
  queueKiotVietCatalog,
  PRODUCT_SYNC_BATCH_SIZE,
} from "@/lib/queue/product-sync-batches";

describe("product sync queue batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue({ id: "job", deduplicated: false });
  });
  it("queues one representative per KiotViet variant family", () => {
    expect(dedupeKiotVietSyncProducts([
      { id: 10, code: "MASTER", name: "Master" },
      { id: 11, masterProductId: 10, code: "BLUE", name: "Blue" },
      { id: 12, masterProductId: 10, code: "RED", name: "Red" },
      { id: 20, code: "SINGLE", name: "Single" },
    ])).toEqual([10, 20]);
  });
  it("queues at most 40 jobs at a time and keeps the direction fixed", async () => {
    let active = 0;
    let maxActive = 0;
    mocks.enqueue.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { id: "job" };
    });
    const ids = Array.from({ length: PRODUCT_SYNC_BATCH_SIZE * 2 + 1 }, (_, index) => index + 1);
    await expect(
      enqueueKiotVietProductSyncJobs(ids, { direction: "shopify_to_kiotviet" }),
    ).resolves.toEqual({ queued: ids.length, failed: 0, deduplicated: 0 });
    expect(maxActive).toBe(PRODUCT_SYNC_BATCH_SIZE);
    expect(mocks.enqueue).toHaveBeenCalledTimes(ids.length);
    for (const call of mocks.enqueue.mock.calls) {
      expect(call[1]).toBe("kiotviet_product_to_shopify");
      expect(call[2]).toMatchObject({ direction: "kiotviet_to_shopify" });
    }
  });

  it("skips inactive, unsaleable, and empty-SKU products", () => {
    const result = dedupeKiotVietSyncProducts([
      { id: 1, code: "ACTIVE", name: "Active" },
      { id: 2, code: "INACTIVE", name: "Inactive", isActive: false },
      { id: 3, code: "NO-SALE", name: "No sale", allowsSale: false },
      { id: 4, code: "  ", name: "No SKU" },
    ]);
    expect(result).toEqual([1]);
  });

  it("counts a concurrently deduplicated queue request as skipped", async () => {
    mocks.enqueue.mockReset().mockResolvedValue({ id: "existing", deduplicated: true });
    await expect(enqueueKiotVietProductSyncJobs([501])).resolves.toEqual({
      queued: 0, failed: 0, deduplicated: 1,
    });
  });

  it("streams catalog pages and deduplicates a family across page boundaries", async () => {
    mocks.getProducts
      .mockResolvedValueOnce({
        total: 5, pageSize: 3,
        data: [
          { id: 11, masterProductId: 10, code: "BLUE", name: "Blue" },
          { id: 20, code: "SINGLE", name: "Single" },
          { id: 30, code: "", name: "Invalid" },
        ],
      })
      .mockResolvedValueOnce({
        total: 5, pageSize: 3,
        data: [
          { id: 10, hasVariants: true, code: "MASTER", name: "Master" },
          { id: 12, masterProductId: 10, code: "RED", name: "Red" },
        ],
      });
    await expect(queueKiotVietCatalog()).resolves.toEqual({
      total: 5, queued: 2, skipped: 3, failed: 0,
    });
    expect(mocks.enqueue.mock.calls.map((call) => call[2].productId)).toEqual([11, 20]);
    expect(mocks.getProducts).toHaveBeenCalledTimes(2);
  });
});
