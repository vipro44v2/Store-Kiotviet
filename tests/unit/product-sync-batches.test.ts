import { describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: enqueue }));

import {
  dedupeKiotVietSyncProducts,
  enqueueKiotVietProductSyncJobs,
  PRODUCT_SYNC_BATCH_SIZE,
} from "@/lib/queue/product-sync-batches";

describe("product sync queue batching", () => {
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
    enqueue.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { id: "job" };
    });
    const ids = Array.from({ length: PRODUCT_SYNC_BATCH_SIZE * 2 + 1 }, (_, index) => index + 1);
    await expect(
      enqueueKiotVietProductSyncJobs(ids, { direction: "shopify_to_kiotviet" }),
    ).resolves.toEqual({ queued: ids.length, failed: 0 });
    expect(maxActive).toBe(PRODUCT_SYNC_BATCH_SIZE);
    expect(enqueue).toHaveBeenCalledTimes(ids.length);
    for (const call of enqueue.mock.calls) {
      expect(call[1]).toBe("kiotviet_product_to_shopify");
      expect(call[2]).toMatchObject({ direction: "kiotviet_to_shopify" });
    }
  });
});
