import { runMappingBackfill } from "./mapping-backfill";

export async function initializeProductMappings() {
  const report = await runMappingBackfill({ apply: true });
  return {
    shopifyVariants: report.totalShopifySkus,
    kiotVietProducts: report.totalKiotVietCodes,
    matched: report.alreadyMapped + report.newMappings,
    unmatchedShopify: report.missingKiotViet,
    unmatchedKiotViet: report.missingShopify,
    duplicateShopifySku: report.duplicateAmbiguous,
    duplicateKiotVietSku: 0,
    errors: report.errors,
  };
}
