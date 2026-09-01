import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { enqueueKiotVietProductSyncJobs, resolveSelectedKiotVietProducts } from "@/lib/queue/product-sync-batches";
import { log } from "@/lib/logger";

const schema = z.object({
  productIds: z.array(z.number().int().positive()).min(1).max(200),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const input = schema.parse(await request.json());
    const selection = await resolveSelectedKiotVietProducts(input.productIds);
    const queueResult = await enqueueKiotVietProductSyncJobs(selection.candidates);
    await log("info", "Manual KiotViet to Shopify product sync queued", {
      action: "manual_product_sync_queued",
      provider: "kiotviet",
      entityType: "product",
      entityId: selection.candidates.length === 1
        ? String(selection.candidates[0].productId)
        : "bulk",
      direction: "kiotviet_to_shopify",
      queued: queueResult.queued,
      failed: queueResult.failed + selection.failed,
      skipped: selection.skipped + queueResult.deduplicated,
      kiotVietProductIds: selection.candidates.map((item) => item.productId),
    });
    return Response.json(
      {
        success: true,
        direction: "kiotviet_to_shopify",
        queued: queueResult.queued,
        failed: queueResult.failed + selection.failed,
        skipped: selection.skipped + queueResult.deduplicated,
      },
      { status: 202 },
    );
  } catch (error) {
    return adminApiErrorResponse(error, "Could not queue product sync");
  }
}
