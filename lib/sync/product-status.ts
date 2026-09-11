import { settingsRepository } from "@/repositories/settings";
import type { KiotVietProduct } from "@/lib/kiotviet/types";
import { log } from "@/lib/logger";
import { parseDraftCategoryIds } from "@/lib/settings/draft-categories";

export type ProductStatus = "ACTIVE" | "DRAFT";

export async function getDraftCategoryIds(): Promise<number[]> {
  const value = await settingsRepository.get<unknown>("draft_product_categories");
  return parseDraftCategoryIds(value);
}

export async function resolveProductStatus(products: KiotVietProduct[]): Promise<ProductStatus> {
  const ids = await getDraftCategoryIds();
  const primary = products.find((product) => !product.masterProductId) ?? products[0];
  const normalStatus = primary.isActive === false || primary.allowsSale === false ? "DRAFT" : "ACTIVE";
  const match = products.find((product) => product.isActive !== false && product.allowsSale !== false &&
    product.categoryId !== undefined && ids.includes(product.categoryId));
  const reason = normalStatus === "ACTIVE" && match ? "configured_draft_category" : "normal_product_status";
  const resolvedStatus = reason === "configured_draft_category" ? "DRAFT" : normalStatus;
  const source = reason === "configured_draft_category" ? match! : primary;
  await log("info", "Shopify product status resolved", {
    action: "shopify_product_status_resolved",
    kiotVietProductId: source.id,
    categoryId: source.categoryId ?? null,
    categoryName: source.categoryName ?? null,
    resolvedStatus,
    reason,
  });
  return resolvedStatus;
}
