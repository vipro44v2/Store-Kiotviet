import { kiotVietFetch } from "./client";
import type { GetProductsParams, KiotVietProductsResponse } from "./types";
import type { KiotVietProduct } from "./types";

export interface KiotVietCategory {
  id: number;
  categoryId?: number;
  name?: string;
  categoryName?: string;
}
interface KiotVietCategoryResponse {
  data: KiotVietCategory;
}
interface KiotVietCategoriesResponse {
  total: number;
  pageSize: number;
  data: KiotVietCategory[];
}

const SEARCH_PARAMETER = "name";

export async function getKiotVietProducts(
  params: GetProductsParams = {},
): Promise<KiotVietProductsResponse> {
  const query = new URLSearchParams({
    pageSize: String(params.pageSize ?? 20),
    currentItem: String(params.currentItem ?? 0),
    includeInventory: String(params.includeInventory ?? true),
  });

  if (params.orderBy) query.set("orderBy", params.orderBy);
  if (params.orderDirection) query.set("orderDirection", params.orderDirection);
  if (params.categoryId) query.set("categoryId", String(params.categoryId));
  if (params.masterProductId)
    query.set("masterProductId", String(params.masterProductId));
  if (params.isActive !== undefined)
    query.set("isActive", String(params.isActive));
  if (params.searchTerm?.trim()) {
    // KiotViet's product filter uses `name` for a code/name search. Keep this
    // mapping isolated here in case the API contract changes.
    query.set(SEARCH_PARAMETER, params.searchTerm.trim());
  }

  return kiotVietFetch<KiotVietProductsResponse>(
    `/products?${query.toString()}`,
  );
}

export async function getAllKiotVietCategories(): Promise<KiotVietCategory[]> {
  const categories: KiotVietCategory[] = [];
  let currentItem = 0;
  let total = 1;
  while (currentItem < total) {
    const page = await kiotVietFetch<KiotVietCategoriesResponse>(
      `/categories?${new URLSearchParams({ pageSize: "100", currentItem: String(currentItem) })}`,
    );
    categories.push(...(page.data ?? []));
    total = page.total ?? categories.length;
    currentItem += page.pageSize || 100;
  }
  return categories;
}

export async function getAllKiotVietProductsByCategory(
  categoryId: number,
): Promise<KiotVietProduct[]> {
  return getAllKiotVietProducts({ categoryId });
}

export async function getAllKiotVietProducts(
  params: Pick<GetProductsParams, "categoryId"> = {},
): Promise<KiotVietProduct[]> {
  const products: KiotVietProduct[] = [];
  let currentItem = 0;
  let total = 1;
  while (currentItem < total) {
    const page = await getKiotVietProducts({
      ...params,
      currentItem,
      pageSize: 100,
      includeInventory: false,
    });
    products.push(...page.data);
    total = page.total;
    currentItem += page.pageSize || 100;
  }
  return products;
}

export function getKiotVietProduct(id: number): Promise<KiotVietProduct> {
  return kiotVietFetch<KiotVietProduct>(`/products/${id}`);
}

export async function getKiotVietCategory(
  id: number,
): Promise<KiotVietCategory> {
  const response = await kiotVietFetch<KiotVietCategoryResponse>(
    `/categories/${id}`,
  );
  return response.data;
}

export async function getKiotVietVariantFamily(
  product: KiotVietProduct,
): Promise<KiotVietProduct[]> {
  if (
    !product.hasVariants &&
    !product.masterProductId &&
    !product.attributes?.length
  )
    return [product];
  const rootId = product.masterProductId ?? product.id;
  const family = new Map<number, KiotVietProduct>();
  let currentItem = 0;
  let total = 1;
  while (currentItem < total) {
    const page = await getKiotVietProducts({
      masterProductId: rootId,
      currentItem,
      pageSize: 100,
      includeInventory: true,
    });
    for (const item of page.data)
      if (item.id === rootId || item.masterProductId === rootId)
        family.set(item.id, item);
    total = page.total;
    currentItem += page.pageSize;
  }
  family.set(product.id, product);
  return [...family.values()];
}
