import { getKiotVietProducts } from "@/lib/kiotviet/products";
import { getShopifyVariants } from "@/lib/shopify/products";
import { mappingsRepository, type MappingRecord } from "@/repositories/mappings";
import type { KiotVietProduct } from "@/lib/kiotviet/types";
import type { ShopifyVariant } from "@/types/shopify";
import { buildSkuMapping, normalizeSku } from "./mappings";

export interface MappingBackfillReport {
  dryRun: boolean;
  totalShopifySkus: number;
  totalKiotVietCodes: number;
  alreadyMapped: number;
  newMappings: number;
  missingShopify: number;
  missingKiotViet: number;
  duplicateAmbiguous: number;
  errors: string[];
}

export async function fetchAllShopifySkuVariants(): Promise<ShopifyVariant[]> {
  const variants: ShopifyVariant[] = [];
  let cursor: string | undefined;
  do {
    const page = await getShopifyVariants(cursor);
    variants.push(...page.productVariants.nodes.filter((item) => normalizeSku(item.sku)));
    cursor = page.productVariants.pageInfo.hasNextPage ? page.productVariants.pageInfo.endCursor : undefined;
  } while (cursor);
  return variants;
}

export async function fetchAllKiotVietCodedProducts(): Promise<KiotVietProduct[]> {
  const products: KiotVietProduct[] = [];
  let currentItem = 0;
  let total = 1;
  while (currentItem < total) {
    const page = await getKiotVietProducts({ pageSize: 100, currentItem, includeInventory: false });
    products.push(...page.data.filter((item) => normalizeSku(item.code)));
    total = page.total;
    currentItem += page.pageSize || 100;
  }
  return products;
}

function isSameMapping(mapping: MappingRecord, shopify: ShopifyVariant, kiotviet: KiotVietProduct) {
  return mapping.shopify_product_id === shopify.product.id && mapping.shopify_variant_id === shopify.id && mapping.kiotviet_product_id === String(kiotviet.id);
}

export async function runMappingBackfill(options: { apply?: boolean } = {}): Promise<MappingBackfillReport> {
  const apply = options.apply === true;
  const [shopify, kiotviet, existing] = await Promise.all([
    fetchAllShopifySkuVariants(), fetchAllKiotVietCodedProducts(), mappingsRepository.listAll(),
  ]);
  const candidates = buildSkuMapping(shopify, kiotviet);
  const bySku = new Map<string, MappingRecord[]>();
  for (const mapping of existing) {
    const key = normalizeSku(mapping.normalized_sku || mapping.sku);
    bySku.set(key, [...(bySku.get(key) ?? []), mapping]);
  }
  let alreadyMapped = 0;
  let newMappings = 0;
  let existingAmbiguous = 0;
  const errors: string[] = [];
  for (const candidate of candidates.matched) {
    const records = bySku.get(candidate.sku) ?? [];
    const complete = records.filter((item) => item.shopify_variant_id && item.kiotviet_product_id);
    if (complete.some((item) => isSameMapping(item, candidate.shopify, candidate.kiotviet))) {
      alreadyMapped++;
      continue;
    }
    if (complete.length || records.length > 1) {
      existingAmbiguous++;
      errors.push(`SKU ${candidate.sku} has an existing conflicting or ambiguous mapping`);
      continue;
    }
    if (apply) {
      try {
        await mappingsRepository.upsert({
          sku: candidate.kiotviet.code, normalized_sku: candidate.sku,
          shopify_product_id: candidate.shopify.product.id, shopify_variant_id: candidate.shopify.id,
          shopify_inventory_item_id: candidate.shopify.inventoryItem.id,
          kiotviet_product_id: String(candidate.kiotviet.id), kiotviet_code: candidate.kiotviet.code,
          sync_direction: "kiotviet_to_shopify", sync_status: "mapped",
        });
      } catch (error) {
        errors.push(`SKU ${candidate.sku}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    newMappings++;
  }
  const ambiguousSkus = new Set([...candidates.duplicateShopify, ...candidates.duplicateKiotViet]);
  return {
    dryRun: !apply, totalShopifySkus: shopify.length, totalKiotVietCodes: kiotviet.length,
    alreadyMapped, newMappings, missingShopify: candidates.unmatchedKiotViet.length,
    missingKiotViet: candidates.unmatchedShopify.length,
    duplicateAmbiguous: ambiguousSkus.size + existingAmbiguous, errors,
  };
}
