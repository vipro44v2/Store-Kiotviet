import {
  getKiotVietProduct,
  getKiotVietVariantFamily,
} from "@/lib/kiotviet/products";
import {
  archiveShopifyProduct,
  collapseShopifyVariantGroup,
  createShopifyProduct,
  findShopifyVariantsBySku,
  setShopifyVariantGroup,
  shopifyProductHasCustomOptions,
  updateShopifyProduct,
} from "@/lib/shopify/products";
import { mappingsRepository } from "@/repositories/mappings";
import { normalizeSku } from "./mappings";
import { syncHash } from "./hashes";
import { syncInventoryNotification } from "./inventory-sync";
import { query } from "@/lib/db/client";
import { log } from "@/lib/logger";
import type { KiotVietProduct } from "@/lib/kiotviet/types";

function productState(product: KiotVietProduct) {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    description: product.description ?? "",
    categoryName: product.categoryName ?? "",
    basePrice: product.basePrice ?? 0,
    barCode: product.barCode ?? "",
    weight: product.weight ?? null,
    attributes: product.attributes ?? [],
    isActive: product.isActive !== false,
    allowsSale: product.allowsSale !== false,
    images: product.images ?? [],
  };
}

export function shouldSkipUnchangedProduct(
  hash: string,
  mappings: Array<{ last_sync_hash: string | null; sync_status?: string }>,
  relatedMappings = mappings,
) {
  return (
    mappings.length === 1 &&
    mappings[0].last_sync_hash === hash &&
    !relatedMappings.some((mapping) => mapping.sync_status === "archived")
  );
}

async function saveMapping(
  product: KiotVietProduct,
  saved: { id: string; product: { id: string }; inventoryItem: { id: string } },
  hash: string,
) {
  const sku = normalizeSku(product.code);
  await mappingsRepository.upsert({
    sku: product.code,
    normalized_sku: sku,
    shopify_product_id: saved.product.id,
    shopify_variant_id: saved.id,
    shopify_inventory_item_id: saved.inventoryItem.id,
    kiotviet_product_id: String(product.id),
    kiotviet_code: product.code,
    sync_direction: "kiotviet_to_shopify",
  });
  await query(
    "UPDATE product_mappings SET last_sync_hash=$2,last_source='kiotviet',last_kiotviet_sync_at=now(),sync_status='synced',updated_at=now() WHERE normalized_sku=$1",
    [sku, hash],
  );
}

async function syncInventory(product: KiotVietProduct, jobId?: string) {
  for (const inventory of product.inventories ?? []) {
    await syncInventoryNotification(
      {
        ProductId: product.id,
        ProductCode: product.code,
        ProductName: product.name,
        BranchId: inventory.branchId,
        BranchName: inventory.branchName,
        Cost: 0,
        OnHand: inventory.onHand,
        Reserved: inventory.reserved ?? inventory.actualReserved ?? 0,
      },
      jobId,
    );
  }
}

async function syncVariantFamily(
  products: KiotVietProduct[],
  trigger: KiotVietProduct,
  jobId?: string,
) {
  const hash = syncHash(
    products
      .map(productState)
      .sort((left, right) => left.code.localeCompare(right.code)),
  );
  const triggerMappings = await mappingsRepository.findBySku(
    normalizeSku(trigger.code),
  );
  const familyMappings = (
    await Promise.all(
      products.map((product) =>
        mappingsRepository.findBySku(normalizeSku(product.code)),
      ),
    )
  ).flat();
  if (shouldSkipUnchangedProduct(hash, triggerMappings, familyMappings))
    return { sku: trigger.code, updated: false, reason: "unchanged" };
  const productIds = [
    ...new Set(
      familyMappings
        .map((mapping) => mapping.shopify_product_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (productIds.length > 1)
    throw new Error(
      `KiotViet variant family is mapped to multiple Shopify products: ${productIds.join(", ")}`,
    );
  const saved = await setShopifyVariantGroup(products, productIds[0]);
  const savedBySku = new Map(
    saved.variants.map((variant) => [normalizeSku(variant.sku), variant]),
  );
  for (const product of products) {
    const variant = savedBySku.get(normalizeSku(product.code));
    if (!variant)
      throw new Error(`Shopify did not return variant ${product.code}`);
    await saveMapping(product, variant, hash);
    await syncInventory(product, jobId);
  }
  await log("info", "KiotViet variant family synchronized to Shopify", {
    action: "set_shopify_variants",
    provider: "shopify",
    entityType: "product",
    entityId: saved.productId,
    jobId,
    variants: products.map((product) => product.code),
  });
  return { sku: trigger.code, updated: true, variants: products.length };
}

export async function syncDeletedKiotVietProducts(
  productIds: number[],
  jobId?: string,
) {
  for (const productId of productIds) {
    const deletedMappings = await query<{ shopify_product_id: string | null }>(
      "SELECT shopify_product_id FROM product_mappings WHERE kiotviet_product_id=$1",
      [String(productId)],
    );
    const shopifyProductId = deletedMappings[0]?.shopify_product_id;
    if (!shopifyProductId) continue;
    const familyMappings = await query<{ kiotviet_product_id: string | null }>(
      "SELECT kiotviet_product_id FROM product_mappings WHERE shopify_product_id=$1 AND kiotviet_product_id<>$2",
      [shopifyProductId, String(productId)],
    );
    const remaining = (
      await Promise.all(
        familyMappings.map(async (mapping) => {
          if (!mapping.kiotviet_product_id) return undefined;
          return getKiotVietProduct(Number(mapping.kiotviet_product_id)).catch(
            () => undefined,
          );
        }),
      )
    ).filter((product): product is KiotVietProduct => Boolean(product));

    if (!remaining.length) {
      await archiveShopifyProduct(shopifyProductId);
      await query(
        "UPDATE product_mappings SET sync_status='archived',updated_at=now() WHERE shopify_product_id=$1",
        [shopifyProductId],
      );
      continue;
    }

    const hash = syncHash(
      remaining
        .map(productState)
        .sort((left, right) => left.code.localeCompare(right.code)),
    );
    if (remaining.length === 1 && !remaining[0].attributes?.length) {
      const saved = await collapseShopifyVariantGroup(
        remaining[0],
        shopifyProductId,
      );
      await saveMapping(remaining[0], saved, hash);
      await syncInventory(remaining[0], jobId);
    } else {
      const saved = await setShopifyVariantGroup(remaining, shopifyProductId);
      const savedBySku = new Map(
        saved.variants.map((variant) => [normalizeSku(variant.sku), variant]),
      );
      for (const product of remaining) {
        const variant = savedBySku.get(normalizeSku(product.code));
        if (!variant)
          throw new Error(`Shopify did not return variant ${product.code}`);
        await saveMapping(product, variant, hash);
        await syncInventory(product, jobId);
      }
    }
    await query("DELETE FROM product_mappings WHERE kiotviet_product_id=$1", [
      String(productId),
    ]);
  }
}

export async function syncKiotVietProductToShopify(
  productId: number,
  jobId?: string,
  priceOverrides: ReadonlyMap<number, number> = new Map(),
) {
  const fetchedProduct = await getKiotVietProduct(productId);
  const product = priceOverrides.has(productId)
    ? { ...fetchedProduct, basePrice: priceOverrides.get(productId)! }
    : fetchedProduct;
  const sku = normalizeSku(product.code);
  if (!sku) throw new Error(`KiotViet product ${productId} has no SKU`);
  const family = (await getKiotVietVariantFamily(product)).map((item) =>
    priceOverrides.has(item.id)
      ? { ...item, basePrice: priceOverrides.get(item.id)! }
      : item,
  );
  if (
    product.hasVariants ||
    product.masterProductId ||
    product.attributes?.length ||
    family.length > 1
  ) {
    return syncVariantFamily(family, product, jobId);
  }

  const hash = syncHash(productState(product));
  const mappings = await mappingsRepository.findBySku(sku);
  let variant =
    mappings.length === 1 && mappings[0].shopify_variant_id
      ? {
          id: mappings[0].shopify_variant_id,
          sku: product.code,
          product: { id: mappings[0].shopify_product_id!, title: product.name },
          inventoryItem: {
            id: mappings[0].shopify_inventory_item_id!,
            tracked: true,
          },
        }
      : undefined;
  if (shouldSkipUnchangedProduct(hash, mappings))
    return { sku, updated: false, reason: "unchanged" };
  if (!variant) {
    const matches = await findShopifyVariantsBySku(product.code);
    if (matches.length > 1)
      throw new Error(`Multiple Shopify variants found for SKU ${sku}`);
    variant = matches[0];
  }
  const saved = variant
    ? (await shopifyProductHasCustomOptions(variant.product.id))
      ? await collapseShopifyVariantGroup(product, variant.product.id)
      : await updateShopifyProduct(product, variant)
    : await createShopifyProduct(product);
  await saveMapping(product, saved, hash);
  await syncInventory(product, jobId);
  await log("info", "KiotViet product synchronized to Shopify", {
    action: "update_shopify_product",
    provider: "shopify",
    entityType: "product",
    entityId: sku,
    jobId,
  });
  return { sku, updated: true };
}
