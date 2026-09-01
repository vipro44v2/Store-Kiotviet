import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { getAllKiotVietProductsByCategory } from "@/lib/kiotviet/products";
import { enqueueKiotVietProductSyncJobs } from "@/lib/queue/product-sync-batches";
import { normalizeSku } from "@/lib/sync/mappings";
import { log } from "@/lib/logger";

const schema = z.object({ categoryId: z.number().int().positive() });

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const { categoryId } = schema.parse(await request.json());
    const products = await getAllKiotVietProductsByCategory(categoryId);
    const bySku = new Map<string, typeof products>();
    for (const product of products) {
      const sku = normalizeSku(product.code);
      if (!sku) continue;
      bySku.set(sku, [...(bySku.get(sku) ?? []), product]);
    }
    const skipped =
      products.filter((product) => !normalizeSku(product.code)).length +
      [...bySku.values()].filter((matches) => matches.length > 1).reduce((count, matches) => count + matches.length, 0);
    const unique = [...bySku.values()].filter((matches) => matches.length === 1).map(([product]) => product);
    const queueResult = await enqueueKiotVietProductSyncJobs(
      unique.map((product) => product.id),
      { categoryId },
    );
    const result = {
      success: true,
      direction: "kiotviet_to_shopify",
      queued: queueResult.queued,
      skipped,
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
