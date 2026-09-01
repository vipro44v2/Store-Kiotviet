import { query } from "@/lib/db/client";
import { getKiotVietProducts } from "@/lib/kiotviet/products";
import { normalizeSku } from "@/lib/sync/mappings";

export const PRODUCT_PAGE_SIZES = [20, 40, 80, 100] as const;

interface MappingMetadata {
  normalized_sku: string;
  kiotviet_product_id: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  sync_status: string;
}

export interface AdminProductDto {
  id: number;
  syncProductId: number;
  name: string;
  sku: string;
  image?: string;
  category: string;
  price: number;
  stock: number | null;
  active: boolean;
  variant: boolean;
  syncStatus: "Not synced" | "Synced" | "Syncing" | "Failed" | "Stale mapping";
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
}

function mappingStatus(productId: number, mapping?: MappingMetadata): AdminProductDto["syncStatus"] {
  if (!mapping) return "Not synced";
  if (mapping.kiotviet_product_id !== String(productId) || mapping.sync_status === "archived")
    return "Stale mapping";
  if (mapping.sync_status === "failed") return "Failed";
  if (["pending", "queued", "syncing"].includes(mapping.sync_status)) return "Syncing";
  return mapping.shopify_product_id && mapping.shopify_variant_id ? "Synced" : "Not synced";
}

export async function getAdminProductCatalogPage(input: {
  page: number;
  pageSize: (typeof PRODUCT_PAGE_SIZES)[number];
  search?: string;
  categoryId?: number;
}) {
  const response = await getKiotVietProducts({
    currentItem: (input.page - 1) * input.pageSize,
    pageSize: input.pageSize,
    includeInventory: true,
    searchTerm: input.search,
    categoryId: input.categoryId,
  });
  const normalizedSkus = [
    ...new Set(response.data.map((product) => normalizeSku(product.code)).filter(Boolean)),
  ];
  const mappings = normalizedSkus.length
    ? await query<MappingMetadata>(
        `SELECT normalized_sku,kiotviet_product_id::text AS kiotviet_product_id,
          shopify_product_id,shopify_variant_id,sync_status
         FROM product_mappings WHERE normalized_sku=ANY($1::text[])`,
        [normalizedSkus],
      ).catch(() => [])
    : [];
  const mappingsBySku = new Map<string, MappingMetadata[]>();
  for (const mapping of mappings)
    mappingsBySku.set(mapping.normalized_sku, [
      ...(mappingsBySku.get(mapping.normalized_sku) ?? []),
      mapping,
    ]);

  const products: AdminProductDto[] = response.data.map((product) => {
    const candidates = mappingsBySku.get(normalizeSku(product.code)) ?? [];
    const exact = candidates.find(
      (mapping) => mapping.kiotviet_product_id === String(product.id),
    );
    const mapping = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    return {
      id: product.id,
      syncProductId: product.masterProductId ?? product.id,
      name: product.fullName || product.name,
      sku: product.code,
      image: product.images?.[0],
      category: product.categoryName ?? "—",
      price: Number(product.basePrice ?? 0),
      stock: product.inventories?.length
        ? product.inventories.reduce((sum, inventory) => sum + Number(inventory.onHand || 0), 0)
        : null,
      active: product.isActive !== false && product.allowsSale !== false,
      variant: Boolean(product.masterProductId || product.hasVariants || product.attributes?.length),
      syncStatus: candidates.length > 1 && !exact ? "Stale mapping" : mappingStatus(product.id, mapping),
      shopifyProductId: mapping?.shopify_product_id ?? null,
      shopifyVariantId: mapping?.shopify_variant_id ?? null,
    };
  });
  const total = Number(response.total ?? 0);
  return {
    products,
    page: input.page,
    pageSize: input.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
  };
}
