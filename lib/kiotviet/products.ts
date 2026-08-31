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
  if (params.searchTerm?.trim()) {
    // KiotViet's product filter uses `name` for a code/name search. Keep this
    // mapping isolated here in case the API contract changes.
    query.set(SEARCH_PARAMETER, params.searchTerm.trim());
  }

  return kiotVietFetch<KiotVietProductsResponse>(
    `/products?${query.toString()}`,
  );
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
  const family: KiotVietProduct[] = [];
  let currentItem = 0;
  let total = 1;
  while (currentItem < total) {
    const page = await getKiotVietProducts({
      currentItem,
      pageSize: 100,
      includeInventory: true,
    });
    family.push(
      ...page.data.filter(
        (item) => item.id === rootId || item.masterProductId === rootId,
      ),
    );
    total = page.total;
    currentItem += page.pageSize;
  }
  return family.length ? family : [product];
}
