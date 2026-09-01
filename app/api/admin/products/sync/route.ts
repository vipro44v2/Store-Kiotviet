import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";
import { enqueueJob } from "@/lib/queue/queues";
import { log } from "@/lib/logger";
import { ensureKiotVietProductMapping } from "@/lib/sync/ensure-kiotviet-product-mapping";

const schema = z.object({
  mappingIds: z.array(z.string().uuid()).min(1).max(200),
});

interface ProductMappingRow {
  id: string;
  kiotviet_product_id: string | null;
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const input = schema.parse(await request.json());
    const mappingIds = [...new Set(input.mappingIds)];
    const rows = await query<ProductMappingRow>(
      `SELECT id,kiotviet_product_id::text AS kiotviet_product_id
       FROM product_mappings WHERE id=ANY($1::uuid[])`,
      [mappingIds],
    );
    const byMappingId = new Map(rows.map((row) => [row.id, row]));
    const missingMappingIds = mappingIds.filter(
      (id) => !byMappingId.get(id)?.kiotviet_product_id,
    );
    const productIds = [
      ...new Set(
        rows
          .map((row) => row.kiotviet_product_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const mappingResults = await Promise.allSettled(
      productIds.map((productId) => ensureKiotVietProductMapping(productId)),
    );
    const readyProductIds: string[] = [];
    let missingShopify = 0;
    let duplicateShopify = 0;
    const mappingErrors: string[] = [];
    mappingResults.forEach((result, index) => {
      if (result.status === "rejected") {
        mappingErrors.push(
          `${productIds[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      } else if (result.value.status === "mapped") {
        readyProductIds.push(result.value.productId);
      } else if (result.value.status === "missing_shopify") missingShopify++;
      else duplicateShopify++;
    });

    await Promise.all(
      readyProductIds.map((productId) =>
        enqueueJob(
          "sync",
          "kiotviet_product_to_shopify",
          {
            productId,
            manual: true,
            direction: "kiotviet_to_shopify",
          },
          "normal",
        ),
      ),
    );
    await log("info", "Manual KiotViet to Shopify product sync queued", {
      action: "manual_product_sync_queued",
      provider: "kiotviet",
      entityType: "product",
      entityId: readyProductIds.length === 1 ? readyProductIds[0] : "bulk",
      direction: "kiotviet_to_shopify",
      queued: readyProductIds.length,
      missingMappings: missingMappingIds.length,
      missingShopify,
      duplicateShopify,
      mappingErrors,
      mappingIds,
      kiotVietProductIds: productIds,
    });
    return Response.json(
      {
        success: true,
        direction: "kiotviet_to_shopify",
        queued: readyProductIds.length,
        missingMappings: missingMappingIds.length,
        missingMappingIds,
        missingShopify,
        duplicateShopify,
        mappingErrors,
        skipped:
          missingMappingIds.length +
          missingShopify +
          duplicateShopify +
          mappingErrors.length,
      },
      { status: 202 },
    );
  } catch (error) {
    return adminApiErrorResponse(error, "Could not queue product sync");
  }
}
