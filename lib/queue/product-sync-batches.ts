import { enqueueJob } from "@/lib/queue/queues";
import type { KiotVietProduct } from "@/lib/kiotviet/types";

export const PRODUCT_SYNC_BATCH_SIZE = 40;

export function dedupeKiotVietSyncProducts(products: KiotVietProduct[]): number[] {
  return [
    ...new Set(
      products
        .map((product) => product.masterProductId ?? product.id)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
}

export async function enqueueKiotVietProductSyncJobs(
  productIds: Array<number | string>,
  extra: Record<string, unknown> = {},
) {
  let queued = 0;
  let failed = 0;
  for (let start = 0; start < productIds.length; start += PRODUCT_SYNC_BATCH_SIZE) {
    const batch = productIds.slice(start, start + PRODUCT_SYNC_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((productId) =>
        enqueueJob(
          "sync",
          "kiotviet_product_to_shopify",
          {
            ...extra,
            productId,
            manual: true,
            direction: "kiotviet_to_shopify",
          },
          "normal",
        ),
      ),
    );
    queued += results.filter((result) => result.status === "fulfilled").length;
    failed += results.filter((result) => result.status === "rejected").length;
  }
  return { queued, failed };
}
