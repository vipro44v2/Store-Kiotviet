import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { getAllKiotVietProductsByCategory } from "@/lib/kiotviet/products";
import { enqueueJob } from "@/lib/queue/queues";
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
    const queued = await Promise.allSettled(
      unique.map((product) => enqueueJob(
        "sync",
        "kiotviet_product_to_shopify",
        { productId: product.id, categoryId, manual: true, direction: "kiotviet_to_shopify" },
        "normal",
      )),
    );
    const result = {
      success: true,
      direction: "kiotviet_to_shopify",
      queued: queued.filter((item) => item.status === "fulfilled").length,
      skipped,
      failed: queued.filter((item) => item.status === "rejected").length,
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
