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
import { mappingsRepository, type MappingRecord } from "@/repositories/mappings";
import { normalizeSku } from "./mappings";
import { syncHash } from "./hashes";
import { syncInventoryNotification } from "./inventory-sync";
import { query } from "@/lib/db/client";
import { log } from "@/lib/logger";
import type { KiotVietProduct } from "@/lib/kiotviet/types";
import { ApiError, MappingError, RetryableError } from "@/lib/errors";
import { resolveProductStatus, type ProductStatus } from "./product-status";

function productState(product: KiotVietProduct) {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    description: product.description ?? "",
    categoryId: product.categoryId ?? null,
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

async function readProductMappings(product: KiotVietProduct, jobId?: string) {
  const sku = normalizeSku(product.code);
  const mappings = await mappingsRepository.findBySku(sku);
  // An excluded family member is not claiming its SKU. Keep only its own active
  // identity for family cleanup, since that SKU may already belong to a successor.
  const activeMappings = mappings.filter((mapping) => mapping.sync_status !== "archived" &&
    (isActiveSaleProduct(product) || mapping.kiotviet_product_id === String(product.id)));
  const archivedMappings = mappings.filter((mapping) => mapping.sync_status === "archived");
  if (activeMappings.some((mapping) => mapping.kiotviet_product_id &&
    mapping.kiotviet_product_id !== String(product.id)))
    throw new MappingError(`SKU ${sku} is mapped to another KiotViet product`);
  if (activeMappings.length > 1)
    throw new MappingError(`Multiple active product mappings exist for SKU ${sku}`);
  // Once the new owner is checkpointed, normal retries do not repeat reuse logs.
  const reclaiming = isActiveSaleProduct(product) && archivedMappings.length > 0 && !activeMappings.some(
    (mapping) => mapping.kiotviet_product_id === String(product.id),
  );
  if (reclaiming)
    await log("info", "Archived SKU mappings ignored for active ownership", {
      action: "archived_sku_mapping_ignored", sku, newKiotVietProductId: String(product.id),
      oldKiotVietProductIds: archivedMappings.map((mapping) => mapping.kiotviet_product_id), jobId,
    });
  return { product, activeMappings, archivedMappings, reclaiming };
}

async function findUniqueShopifyVariant(sku: string) {
  const matches = (await findShopifyVariantsBySku(sku)).filter(
    (match) => normalizeSku(match.sku) === normalizeSku(sku),
  );
  if (matches.length > 1)
    throw new MappingError(`Multiple Shopify variants found for SKU ${normalizeSku(sku)}; manual review required`);
  return matches[0];
}

async function logSkuReclaimed(
  product: KiotVietProduct,
  archivedMappings: MappingRecord[],
  saved: { id: string; product: { id: string } },
  jobId?: string,
) {
  for (const oldId of new Set(archivedMappings.map((mapping) => mapping.kiotviet_product_id)))
    await log("info", "SKU reclaimed from an archived mapping", {
      action: "sku_reclaimed", sku: normalizeSku(product.code),
      oldKiotVietProductId: oldId, newKiotVietProductId: String(product.id),
      shopifyProductId: saved.product.id, shopifyVariantId: saved.id, jobId,
    });
}

async function assertReclaimableShopifyProduct(productId: string, products: KiotVietProduct[]) {
  const otherOwners = await query<{ kiotviet_product_id: string | null }>(
    `SELECT kiotviet_product_id FROM product_mappings
     WHERE shopify_product_id=$1 AND sync_status<>'archived'
       AND (kiotviet_product_id IS NULL OR NOT (kiotviet_product_id::text=ANY($2::text[])))`,
    [productId, products.map((product) => String(product.id))],
  );
  if (otherOwners.length)
    throw new MappingError(`Shopify product ${productId} has active mappings outside this KiotViet family; manual review required`);
}

export function shouldSkipUnchangedProduct(
  hash: string,
  mappings: Array<{ last_sync_hash: string | null; sync_status?: string }>,
  relatedMappings = mappings,
) {
  return (
    mappings.length === 1 &&
    mappings[0].last_sync_hash === hash &&
    !relatedMappings.some((mapping) => mapping.sync_status === "archived" || mapping.sync_status === "mapped")
  );
}

async function saveMapping(
  product: KiotVietProduct,
  saved: { id: string; product: { id: string }; inventoryItem: { id: string } },
  hash: string | null,
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
  }, { resetSyncHash: hash === null });
  if (hash === null) return;
  await query(
    `UPDATE product_mappings
     SET last_sync_hash=$3,last_source='kiotviet',
       last_kiotviet_sync_at=now(),sync_status='synced',updated_at=now()
     WHERE normalized_sku=$1 AND kiotviet_product_id::text=$2
       AND shopify_variant_id=$4 AND sync_status<>'archived'`,
    [sku, String(product.id), hash, saved.id],
  );
}

async function checkpointFamily(
  products: KiotVietProduct[],
  saved: { productId: string; variants: Array<{ id: string; sku: string; product: { id: string }; inventoryItem: { id: string } }> },
) {
  // Persist each identity before media. A partially written family is still
  // recoverable through any committed sibling's common Shopify product ID.
  const bySku = new Map(saved.variants.map((variant) => [normalizeSku(variant.sku), variant]));
  for (const product of products) {
    const variant = bySku.get(normalizeSku(product.code));
    if (!variant || variant.product.id !== saved.productId)
      throw new Error(`Shopify did not return variant ${product.code} in product ${saved.productId}`);
    await saveMapping(product, variant, null);
  }
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
  if (!product.inventories?.length) {
    const message = `KiotViet product ${product.id} (SKU ${product.code}) has no inventory rows; Shopify stock was not reconciled`;
    await log("warn", message, {
      action: "missing_kiotviet_inventory",
      provider: "kiotviet",
      entityType: "product",
      entityId: String(product.id),
      kiotVietProductId: product.id,
      sku: product.code,
      jobId,
    });
    throw new RetryableError(message);
  }
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
  const status = await resolveProductStatus(products);
  const hash = await productSyncHash(products, status);
  const mappingsByProduct = await Promise.all(
    mappingProducts.map((product) => readProductMappings(product, jobId)),
  );
  const triggerMappings =
    mappingsByProduct.find(({ product }) => product.id === trigger.id)?.activeMappings.filter(
      (mapping) => mapping.kiotviet_product_id === String(trigger.id),
    ) ?? [];
  const familyMappings = mappingsByProduct.flatMap(({ activeMappings }) => activeMappings);
  const skuMatches = await Promise.all(products.map((product) => findUniqueShopifyVariant(product.code)));
  const productIds = [
    ...new Set([
      ...familyMappings
        .map((mapping) => mapping.shopify_product_id)
        .filter((id): id is string => Boolean(id)),
      ...skuMatches.flatMap((variant) => variant ? [variant.product.id] : []),
    ]),
  ];
  const existingProductId = await resolveExistingFamilyShopifyProduct(productIds);
  const reclaiming = mappingsByProduct.some((entry) => entry.reclaiming);
  if (existingProductId && reclaiming)
    await assertReclaimableShopifyProduct(existingProductId, mappingProducts);
  if (
    existingProductId &&
    products.every((product) => familyMappings.some((mapping) => mapping.kiotviet_product_id === String(product.id))) &&
    shouldSkipUnchangedProduct(hash, triggerMappings, familyMappings)
  ) {
    for (const product of products) await syncInventory(product, jobId);
    return { sku: trigger.code, updated: false, reason: "unchanged" };
  }
  if (products.length === 1) {
    const saved = existingProductId
      ? await collapseShopifyVariantGroup(products[0], existingProductId, (variant) => saveMapping(products[0], variant, null), status)
      : await createShopifyProduct(products[0], (variant) => saveMapping(products[0], variant, null), status);
    await saveMapping(products[0], saved, hash);
    const entry = mappingsByProduct.find(({ product }) => product.id === products[0].id);
    if (entry?.reclaiming) await logSkuReclaimed(products[0], entry.archivedMappings, saved, jobId);
    await syncInventory(products[0], jobId);
    return { sku: trigger.code, updated: true, variants: 1 };
  }
  const saved = await setShopifyVariantGroup(products, existingProductId, {
    status,
    checkpoint: (group) => checkpointFamily(products, group),
    resumeFields: !reclaiming && familyMappings.some((mapping) => mapping.sync_status === "mapped" && mapping.last_sync_hash === null),
  });
  const savedBySku = new Map(
    saved.variants.map((variant) => [normalizeSku(variant.sku), variant]),
  );
  for (const product of products) {
    const variant = savedBySku.get(normalizeSku(product.code));
    if (!variant)
      throw new Error(`Shopify did not return variant ${product.code}`);
    await saveMapping(product, variant, hash);
    const entry = mappingsByProduct.find((entry) => entry.product.id === product.id);
    if (entry?.reclaiming) await logSkuReclaimed(product, entry.archivedMappings, variant, jobId);
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
    // An ID-bearing old webhook must never fall back to a SKU now owned by B.
    if (!productId && normalizedCode)
      deletedMappings = await query<DeletedMapping>(
        `SELECT shopify_product_id,kiotviet_product_id::text AS kiotviet_product_id,sync_status
        FROM product_mappings
        WHERE normalized_sku=$1 OR upper(trim(kiotviet_code))=$1`,
        [normalizedCode],
      );
    if (deletedMappings.every((mapping) => mapping.sync_status === "archived")) continue;
    const matchedKiotVietIds = new Set(
      deletedMappings.map((mapping) => mapping.kiotviet_product_id).filter(Boolean),
    );
    if (!productId && matchedKiotVietIds.size > 1)
      throw new MappingError(
        `Deleted KiotViet code ${code} matches multiple mapped KiotViet products; product ID required for manual review`,
      );
    deletedMappings = deletedMappings.filter((mapping) => mapping.sync_status !== "archived");
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

    const status = await resolveProductStatus(remaining);
    const hash = await productSyncHash(remaining, status);
    if (remaining.length === 1) {
      const saved = await collapseShopifyVariantGroup(
        remaining[0],
        shopifyProductId,
        (variant) => saveMapping(remaining[0], variant, null),
        status,
      );
      await saveMapping(remaining[0], saved, hash);
      await syncInventory(remaining[0], jobId);
    } else {
      const saved = await setShopifyVariantGroup(remaining, shopifyProductId, {
        status,
        checkpoint: (group) => checkpointFamily(remaining, group),
      });
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

  const status = await resolveProductStatus([product]);
  const hash = await productSyncHash([product], status);
  const { activeMappings: mappings, archivedMappings, reclaiming } = await readProductMappings(product, jobId);
  let variant =
    mappings.length === 1 && mappings[0].shopify_variant_id
      ? await getShopifyVariant(mappings[0].shopify_variant_id)
      : undefined;
  // A new product is checkpointed before its default variant receives its SKU.
  // Only resume an empty SKU when this exact product/source mapping is pending.
  const pendingCreation = variant && !normalizeSku(variant.sku) &&
    mappings[0]?.sync_status === "mapped" && mappings[0].last_sync_hash === null &&
    mappings[0].kiotviet_product_id === String(product.id) &&
    mappings[0].shopify_product_id === variant.product.id;
  if (variant && normalizeSku(variant.sku) !== sku && !pendingCreation) variant = undefined;
  const resumingCheckpoint = variant && mappings[0]?.sync_status === "mapped" &&
    mappings[0].last_sync_hash === null && mappings[0].kiotviet_product_id === String(product.id);
  const match = resumingCheckpoint ? undefined : await findUniqueShopifyVariant(product.code);
  if (variant && match && variant.id !== match.id)
    throw new MappingError(`Shopify variant identity conflicts for SKU ${sku}; manual review required`);
  if (variant && shouldSkipUnchangedProduct(hash, mappings.filter(
    (mapping) => mapping.kiotviet_product_id === String(product.id),
  ))) {
    await syncInventory(product, jobId);
    return { sku, updated: false, reason: "unchanged" };
  }
  variant ??= match;
  if (variant && reclaiming) await assertReclaimableShopifyProduct(variant.product.id, [product]);
  const saved = variant
    ? (await shopifyProductHasCustomOptions(variant.product.id))
      ? await collapseShopifyVariantGroup(product, variant.product.id, (saved) => saveMapping(product, saved, null), status)
      : await updateShopifyProduct(product, variant, true, (saved) => saveMapping(product, saved, null), status)
    : await createShopifyProduct(product, (created) => saveMapping(product, created, null), status);
  await saveMapping(product, saved, hash);
  if (reclaiming) await logSkuReclaimed(product, archivedMappings, saved, jobId);
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

export async function productSyncHash(products: KiotVietProduct[], status?: ProductStatus) {
  return syncHash({
    products: products.map(productState).sort((a, b) => a.code.localeCompare(b.code)),
    resolvedStatus: status ?? await resolveProductStatus(products),
  });
}
