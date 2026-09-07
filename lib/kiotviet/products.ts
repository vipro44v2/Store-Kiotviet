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

export async function getKiotVietProduct(id: number): Promise<KiotVietProduct> {
  const product = await kiotVietFetch<KiotVietProduct>(`/products/${id}`);
  if (product.inventories?.length) return product;

  // The retail API documents inventories in the detail response, but only
  // documents includeInventory on the list endpoint. Use that supported route
  // to hydrate missing rows, keeping detail fields and matching strictly by ID.
  let currentItem = 0;
  let total = 1;
  while (currentItem < total) {
    const page = await getKiotVietProducts({
      searchTerm: product.code,
      includeInventory: true,
      currentItem,
      pageSize: 100,
    });
    const match = page.data.find((item) => item.id === id);
    if (match?.inventories?.length)
      return { ...product, inventories: match.inventories };
    if (match || !page.data.length) break;
    total = page.total;
    currentItem += page.pageSize || 100;
  }
  // Keep metadata available for archive handling and family enrichment.
  // The inventory sync guard reports and rejects unavailable inventory.
  return product;
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
  const fetchedProduct = family.get(product.id);
  family.set(product.id, {
    ...product,
    inventories: product.inventories?.length
      ? product.inventories
      : fetchedProduct?.inventories ?? product.inventories,
  });
  return [...family.values()];
}
