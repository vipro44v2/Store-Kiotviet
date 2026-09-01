import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { queueKiotVietCatalog } from "@/lib/queue/product-sync-batches";
import { log } from "@/lib/logger";

const schema = z.object({ categoryId: z.number().int().positive() });

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const { categoryId } = schema.parse(await request.json());
    const queueResult = await queueKiotVietCatalog({ categoryId });
    const result = {
      success: true,
      direction: "kiotviet_to_shopify",
      total: queueResult.total,
      queued: queueResult.queued,
      skipped: queueResult.skipped,
      failed: queueResult.failed,
    };
    await log("info", "KiotViet category product sync queued", {
      action: "manual_category_product_sync_queued",
      provider: "kiotviet",
      entityType: "category",
      entityId: String(categoryId),
      categoryId,
      ...result,
    });
    return Response.json(result, { status: 202 });
  } catch (error) {
    return adminApiErrorResponse(error, "Could not queue category sync");
  }
}
