import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { runMappingBackfill } from "@/lib/sync/mapping-backfill";
import { log } from "@/lib/logger";

export async function POST(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const report = await runMappingBackfill({ apply: true });
    const result = {
      success: true,
      created: report.newMappings,
      existing: report.alreadyMapped,
      missing: report.missingShopify,
      duplicate: report.duplicateAmbiguous,
      errors: report.errors,
    };
    await log("info", "Create all exact product mappings completed", {
      action: "manual_product_mappings_created",
      provider: "kiotviet",
      entityType: "product_mapping",
      entityId: "all",
      direction: "kiotviet_to_shopify",
      ...result,
    });
    return Response.json(result);
  } catch (error) {
    return adminApiErrorResponse(error, "Could not create product mappings");
  }
}
