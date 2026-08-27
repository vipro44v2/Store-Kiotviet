import { kiotVietFetch } from "./client";
import type { GetProductsParams, KiotVietProductsResponse } from "./types";

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

  return kiotVietFetch<KiotVietProductsResponse>(`/products?${query.toString()}`);
}
