import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { log } from "@/lib/logger";
import { queueKiotVietCatalog } from "@/lib/queue/product-sync-batches";
import { assertTrustedOrigin } from "@/lib/security/csrf";

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const queueResult = await queueKiotVietCatalog();
    const result = {
      success: true,
      direction: "kiotviet_to_shopify",
      total: queueResult.total,
      queued: queueResult.queued,
      skipped: queueResult.skipped,
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
