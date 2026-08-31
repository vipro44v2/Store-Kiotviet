import { MappingError } from "@/lib/errors";
import { getKiotVietProducts } from "@/lib/kiotviet/products";
import { log } from "@/lib/logger";
import { findShopifyVariantsBySku } from "@/lib/shopify/products";
import {
  mappingsRepository,
  type MappingRecord,
} from "@/repositories/mappings";
import { normalizeSku } from "./mappings";

export async function ensureProductMapping(
  skuValue: string,
  jobId?: string,
): Promise<MappingRecord> {
  const sku = normalizeSku(skuValue);
  if (!sku) throw new MappingError("Order line has an empty SKU");

  const existing = await mappingsRepository.findBySku(sku);
  if (existing.length > 1)
    throw new MappingError(`Multiple product mappings exist for SKU ${sku}`);
  if (existing.length === 1) {
    if (existing[0].kiotviet_product_id) return existing[0];
    throw new MappingError(`Product mapping for SKU ${sku} is incomplete`);
  }

  const [shopifyCandidates, kiotVietPage] = await Promise.all([
    findShopifyVariantsBySku(sku),
    getKiotVietProducts({
      searchTerm: sku,
      pageSize: 100,
      currentItem: 0,
      includeInventory: false,
    }),
  ]);
  const shopifyMatches = shopifyCandidates.filter(
    (variant) => normalizeSku(variant.sku) === sku,
  );
  const kiotVietMatches = kiotVietPage.data.filter(
    (product) => normalizeSku(product.code) === sku,
  );
  if (shopifyMatches.length !== 1 || kiotVietMatches.length !== 1)
    throw new MappingError(
      `Cannot auto-map SKU ${sku}: expected exactly one exact match in Shopify and KiotViet, found Shopify=${shopifyMatches.length}, KiotViet=${kiotVietMatches.length}`,
    );

  const shopify = shopifyMatches[0];
  const kiotViet = kiotVietMatches[0];
  const mapping = await mappingsRepository.upsert({
    sku: kiotViet.code,
    normalized_sku: sku,
    shopify_product_id: shopify.product.id,
    shopify_variant_id: shopify.id,
    shopify_inventory_item_id: shopify.inventoryItem.id,
    kiotviet_product_id: String(kiotViet.id),
    kiotviet_code: kiotViet.code,
    sync_direction: "kiotviet_to_shopify",
    sync_status: "mapped",
  });
  await log("info", "Product mapping automatically created for order", {
    action: "auto_map_order_product",
    provider: "shopify",
    entityType: "product_mapping",
    entityId: sku,
    sku,
    shopifyProductId: shopify.product.id,
    shopifyVariantId: shopify.id,
    kiotVietProductId: kiotViet.id,
    jobId,
  });
  return mapping;
}
