import { MappingError } from "@/lib/errors";
import { getKiotVietProduct } from "@/lib/kiotviet/products";
import { findShopifyVariantsBySku } from "@/lib/shopify/products";
import { mappingsRepository, type MappingRecord } from "@/repositories/mappings";
import { normalizeSku } from "./mappings";

export type EnsureKiotVietMappingResult =
  | { status: "mapped"; mapping: MappingRecord; productId: string; sku: string }
  | { status: "missing_shopify" | "duplicate_shopify"; productId: string; sku: string; matches: number };

export async function ensureKiotVietProductMapping(
  productId: string,
): Promise<EnsureKiotVietMappingResult> {
  const numericId = Number(productId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0)
    throw new MappingError(`Invalid KiotViet product ID ${productId}`);
  const product = await getKiotVietProduct(numericId);
  const sku = normalizeSku(product.code);
  if (!sku) throw new MappingError(`KiotViet product ${productId} has no code`);
  const candidates = await findShopifyVariantsBySku(sku);
  const matches = candidates.filter((variant) => normalizeSku(variant.sku) === sku);
  if (matches.length === 0)
    return { status: "missing_shopify", productId, sku, matches: 0 };
  if (matches.length > 1)
    return { status: "duplicate_shopify", productId, sku, matches: matches.length };

  const existing = await mappingsRepository.findBySku(sku);
  if (existing.length > 1)
    throw new MappingError(`Multiple product mappings exist for SKU ${sku}`);
  if (
    existing[0]?.kiotviet_product_id &&
    existing[0].kiotviet_product_id !== String(product.id)
  )
    throw new MappingError(
      `SKU ${sku} is already mapped to KiotViet product ${existing[0].kiotviet_product_id}`,
    );
  const shopify = matches[0];
  await mappingsRepository.upsert({
    sku: product.code,
    normalized_sku: sku,
    kiotviet_product_id: String(product.id),
    kiotviet_code: product.code,
    shopify_product_id: shopify.product.id,
    shopify_variant_id: shopify.id,
    shopify_inventory_item_id: shopify.inventoryItem.id,
    sync_direction: "kiotviet_to_shopify",
    sync_status: "mapped",
  });
  const reconciled = await mappingsRepository.findBySku(sku);
  if (reconciled.length !== 1)
    throw new MappingError(`Mapping for SKU ${sku} could not be reconciled`);
  return { status: "mapped", mapping: reconciled[0], productId: String(product.id), sku };
}
