import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { getAllKiotVietProducts } from "@/lib/kiotviet/products";
import { log } from "@/lib/logger";
import { dedupeKiotVietSyncProducts, enqueueKiotVietProductSyncJobs } from "@/lib/queue/product-sync-batches";
import { assertTrustedOrigin } from "@/lib/security/csrf";

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const products = await getAllKiotVietProducts();
    const productIds = dedupeKiotVietSyncProducts(products);
    const skipped = products.length - productIds.length;
    const queueResult = await enqueueKiotVietProductSyncJobs(productIds);
    const result = {
      success: true,
      direction: "kiotviet_to_shopify",
      queued: queueResult.queued,
      skipped,
      failed: queueResult.failed,
    };
    await log("info", "All KiotViet product sync jobs queued", {
      action: "manual_all_product_sync_queued",
      provider: "kiotviet",
      entityType: "product",
      entityId: "all",
      ...result,
    });
    return Response.json(result, { status: 202 });
  } catch (error) {
    return adminApiErrorResponse(error, "Could not queue all product sync jobs");
  }
}
