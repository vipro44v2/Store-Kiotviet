import {
  getKiotVietProduct,
  getKiotVietVariantFamily,
} from "@/lib/kiotviet/products";
import {
  archiveShopifyProduct,
  collapseShopifyVariantGroup,
  createShopifyProduct,
  findShopifyVariantsBySku,
  getShopifyVariant,
  setShopifyVariantGroup,
  shopifyProductExists,
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
import { ApiError, MappingError } from "@/lib/errors";

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

function isActiveSaleProduct(product: KiotVietProduct) {
  return (
    product.isActive !== false &&
    product.allowsSale !== false &&
    Boolean(normalizeSku(product.code))
  );
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
  await mappingsRepository.upsertExact({
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
    `UPDATE product_mappings
     SET last_sync_hash=$3,last_source='kiotviet',last_kiotviet_sync_at=now(),
       sync_status='synced',updated_at=now()
     WHERE normalized_sku=$1 AND kiotviet_product_id::text=$2
       AND shopify_variant_id=$4`,
    [sku, String(product.id), hash, saved.id],
  );
}

async function archiveFamilyMappings(products: KiotVietProduct[]) {
  if (!products.length) return;
  await query(
    `UPDATE product_mappings SET sync_status='archived',updated_at=now()
     WHERE kiotviet_product_id::text=ANY($1::text[])`,
    [[...new Set(products.map((product) => String(product.id)))]],
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
  mappingProducts: KiotVietProduct[] = products,
) {
  const idsBySku = new Map<string, Set<number>>();
  for (const product of products) {
    const sku = normalizeSku(product.code);
    const ids = idsBySku.get(sku) ?? new Set<number>();
    ids.add(product.id);
    idsBySku.set(sku, ids);
  }
  const duplicateSku = [...idsBySku].find(([, ids]) => ids.size > 1)?.[0];
  if (duplicateSku)
    throw new MappingError(
      `Multiple KiotViet products in the variant family use SKU ${duplicateSku}`,
    );
  const hash = syncHash(
    products
      .map(productState)
      .sort((left, right) => left.code.localeCompare(right.code)),
  );
  const mappingsByProduct = await Promise.all(
    mappingProducts.map(async (product) => ({
      product,
      mappings: await mappingsRepository.findBySku(normalizeSku(product.code)),
    })),
  );
  for (const { product, mappings } of mappingsByProduct) {
    const conflict = mappings.find(
      (mapping) =>
        mapping.kiotviet_product_id &&
        mapping.kiotviet_product_id !== String(product.id),
    );
    if (conflict)
      throw new MappingError(
        `SKU ${normalizeSku(product.code)} is mapped to another KiotViet product`,
      );
  }
  const triggerMappings =
    mappingsByProduct.find(({ product }) => product.id === trigger.id)?.mappings ?? [];
  const familyMappings = mappingsByProduct.flatMap(({ mappings }) => mappings);
  const productIds = [
    ...new Set(
      familyMappings
        .map((mapping) => mapping.shopify_product_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const existingProductId = await resolveExistingFamilyShopifyProduct(productIds);
  if (
    existingProductId &&
    shouldSkipUnchangedProduct(hash, triggerMappings, familyMappings)
  )
    return { sku: trigger.code, updated: false, reason: "unchanged" };
  if (products.length === 1) {
    const saved = existingProductId
      ? await collapseShopifyVariantGroup(products[0], existingProductId)
      : await createShopifyProduct(products[0]);
    await saveMapping(products[0], saved, hash);
    await syncInventory(products[0], jobId);
    return { sku: trigger.code, updated: true, variants: 1 };
  }
  const saved = await setShopifyVariantGroup(products, existingProductId);
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

export async function resolveExistingFamilyShopifyProduct(
  mappedProductIds: string[],
): Promise<string | undefined> {
  const uniqueIds = [...new Set(mappedProductIds.filter(Boolean))];
  const existence = await Promise.all(
    uniqueIds.map(async (id) => ({ id, exists: await shopifyProductExists(id) })),
  );
  const existingProductIds = existence.filter((item) => item.exists).map((item) => item.id);
  if (existingProductIds.length > 1)
    throw new MappingError(
      `KiotViet variant family is mapped to multiple existing Shopify products: ${existingProductIds.join(", ")}`,
    );
  return existingProductIds[0];
}

export async function syncDeletedKiotVietProducts(
  references: Array<number | { id?: number; code?: string }>,
  jobId?: string,
) {
  for (const reference of references) {
    const productId = typeof reference === "number" ? reference : reference.id;
    const code = typeof reference === "number" ? undefined : reference.code;
    const normalizedCode = normalizeSku(code ?? "");
    type DeletedMapping = {
      shopify_product_id: string | null;
      kiotviet_product_id: string | null;
      sync_status: string;
    };
    let deletedMappings: DeletedMapping[] = [];
    if (productId)
      deletedMappings = await query<DeletedMapping>(
        `SELECT shopify_product_id,kiotviet_product_id::text AS kiotviet_product_id,sync_status
        FROM product_mappings WHERE kiotviet_product_id::text=$1`,
        [String(productId)],
      );
    if (!deletedMappings.length && normalizedCode)
      deletedMappings = await query<DeletedMapping>(
        `SELECT shopify_product_id,kiotviet_product_id::text AS kiotviet_product_id,sync_status
        FROM product_mappings
        WHERE normalized_sku=$1 OR upper(trim(kiotviet_code))=$1`,
        [normalizedCode],
      );
    const matchedKiotVietIds = new Set(
      deletedMappings.map((mapping) => mapping.kiotviet_product_id).filter(Boolean),
    );
    if (!productId && matchedKiotVietIds.size > 1)
      throw new MappingError(
        `Deleted KiotViet code ${code} matches multiple mapped KiotViet products`,
      );
    const productIds = [
      ...new Set(
        deletedMappings
          .map((mapping) => mapping.shopify_product_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (productIds.length > 1)
      throw new MappingError(
        `Deleted KiotViet product ${productId ?? code} maps to multiple Shopify products`,
      );
    const shopifyProductId = productIds[0];
    if (!shopifyProductId) continue;
    if (deletedMappings.every((mapping) => mapping.sync_status === "archived"))
      continue;
    const mappedKiotVietIds = [
      ...new Set(
        deletedMappings
          .map((mapping) => mapping.kiotviet_product_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const familyMappings = await query<{ kiotviet_product_id: string | null }>(
      "SELECT kiotviet_product_id::text AS kiotviet_product_id FROM product_mappings WHERE shopify_product_id=$1 AND NOT (kiotviet_product_id::text=ANY($2::text[])) AND sync_status<>'archived'",
      [shopifyProductId, mappedKiotVietIds],
    );
    const remaining = (
      await Promise.all(
        familyMappings.map(async (mapping) => {
          if (!mapping.kiotviet_product_id) return undefined;
          return getKiotVietProduct(Number(mapping.kiotviet_product_id)).catch(
            (error: unknown) => {
              if (error instanceof ApiError && error.status === 404) return undefined;
              throw error;
            },
          );
        }),
      )
    ).filter(
      (product): product is KiotVietProduct =>
        Boolean(product) && product!.isActive !== false && product!.allowsSale !== false,
    );

    if (!remaining.length) {
      await archiveShopifyProduct(shopifyProductId);
      await query(
        "UPDATE product_mappings SET sync_status='archived',updated_at=now() WHERE shopify_product_id=$1",
        [shopifyProductId],
      );
      await log("info", "Shopify product archived after KiotViet deletion", {
        action: "archive_shopify_product",
        provider: "shopify",
        entityType: "product",
        entityId: shopifyProductId,
        kiotVietProductId: productId,
        kiotVietCode: code,
        jobId,
      });
      continue;
    }

    const hash = syncHash(
      remaining
        .map(productState)
        .sort((left, right) => left.code.localeCompare(right.code)),
    );
    if (remaining.length === 1) {
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
    await query(
      "UPDATE product_mappings SET sync_status='archived',updated_at=now() WHERE kiotviet_product_id::text=ANY($1::text[])",
      [mappedKiotVietIds],
    );
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
  const family = (await getKiotVietVariantFamily(product)).map((item) =>
    priceOverrides.has(item.id)
      ? { ...item, basePrice: priceOverrides.get(item.id)! }
      : item,
  );
  const validFamily = family.filter(isActiveSaleProduct);
  const excludedFamily = family.filter((item) => !isActiveSaleProduct(item));
  if (!isActiveSaleProduct(product)) {
    if (!validFamily.length) {
      await syncDeletedKiotVietProducts(
        family.map((item) => ({ id: item.id })),
        jobId,
      );
      return { sku: normalizeSku(product.code), updated: false, reason: "inactive" };
    }
    const result = await syncVariantFamily(validFamily, validFamily[0], jobId, family);
    await archiveFamilyMappings(excludedFamily);
    return result;
  }
  const sku = normalizeSku(product.code);
  if (!sku) throw new Error(`KiotViet product ${productId} has no SKU`);
  if (
    product.hasVariants ||
    product.masterProductId ||
    product.attributes?.length ||
    family.length > 1
  ) {
    const result = await syncVariantFamily(validFamily, product, jobId, family);
    await archiveFamilyMappings(excludedFamily);
    return result;
  }

  const hash = syncHash(productState(product));
  const mappings = await mappingsRepository.findBySku(sku);
  if (
    mappings.some(
      (mapping) =>
        mapping.kiotviet_product_id &&
        mapping.kiotviet_product_id !== String(product.id),
    )
  )
    throw new MappingError(`SKU ${sku} is mapped to another KiotViet product`);
  let variant =
    mappings.length === 1 && mappings[0].shopify_variant_id
      ? await getShopifyVariant(mappings[0].shopify_variant_id)
      : undefined;
  if (variant && normalizeSku(variant.sku) !== sku) variant = undefined;
  if (variant && shouldSkipUnchangedProduct(hash, mappings))
    return { sku, updated: false, reason: "unchanged" };
  if (!variant) {
    const matches = (await findShopifyVariantsBySku(product.code)).filter(
      (match) => normalizeSku(match.sku) === sku,
    );
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
