import { getKiotVietProduct, getKiotVietProducts } from "@/lib/kiotviet/products";
import type { KiotVietProduct } from "@/lib/kiotviet/types";
import { normalizeSku } from "@/lib/sync/mappings";
import { enqueueJob } from "@/lib/queue/queues";

export const PRODUCT_SYNC_BATCH_SIZE = 40;
const KIOTVIET_PAGE_SIZE = 100;

export interface ProductSyncCandidate {
  productId: number;
  familyKey: string;
}

export function isBulkSyncEligible(product: KiotVietProduct): boolean {
  return (
    product.isActive !== false &&
    product.allowsSale !== false &&
    Boolean(normalizeSku(product.code))
  );
}

function familyKey(product: KiotVietProduct, familyRoots: ReadonlySet<number>): string {
  return product.masterProductId
    ? `family:${product.masterProductId}`
    : product.hasVariants || familyRoots.has(product.id)
      ? `family:${product.id}`
      : `product:${product.id}`;
}

export function selectKiotVietSyncCandidates(
  products: KiotVietProduct[],
  seenFamilyKeys: Set<string> = new Set(),
): { candidates: ProductSyncCandidate[]; skipped: number } {
  const candidates: ProductSyncCandidate[] = [];
  let skipped = 0;
  const productIdsBySku = new Map<string, Set<number>>();
  for (const product of products) {
    const sku = normalizeSku(product.code);
    if (!sku) continue;
    const ids = productIdsBySku.get(sku) ?? new Set<number>();
    ids.add(product.id);
    productIdsBySku.set(sku, ids);
  }
  const conflictingSkus = new Set(
    [...productIdsBySku]
      .filter(([, ids]) => ids.size > 1)
      .map(([sku]) => sku),
  );
  const familyRoots = new Set(
    products
      .map((product) => product.masterProductId)
      .filter((id): id is number => Boolean(id)),
  );
  for (const product of products) {
    if (!isBulkSyncEligible(product)) {
      skipped++;
      continue;
    }
    if (conflictingSkus.has(normalizeSku(product.code))) {
      skipped++;
      continue;
    }
    const key = familyKey(product, familyRoots);
    if (seenFamilyKeys.has(key)) {
      skipped++;
      continue;
    }
    seenFamilyKeys.add(key);
    // This ID came from KiotViet's response, so /products/{id} is fetchable.
    candidates.push({ productId: product.id, familyKey: key });
  }
  return { candidates, skipped };
}

export function dedupeKiotVietSyncProducts(products: KiotVietProduct[]): number[] {
  return selectKiotVietSyncCandidates(products).candidates.map(
    (candidate) => candidate.productId,
  );
}

export async function enqueueKiotVietProductSyncJobs(
  candidates: Array<number | string | ProductSyncCandidate>,
  extra: Record<string, unknown> = {},
) {
  let queued = 0;
  let failed = 0;
  let deduplicated = 0;
  for (let start = 0; start < candidates.length; start += PRODUCT_SYNC_BATCH_SIZE) {
    const batch = candidates.slice(start, start + PRODUCT_SYNC_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((candidate) => {
        const item = typeof candidate === "object"
          ? candidate
          : { productId: candidate, familyKey: `product:${candidate}` };
        return enqueueJob(
          "sync",
          "kiotviet_product_to_shopify",
          { ...extra, productId: item.productId, manual: true, direction: "kiotviet_to_shopify" },
          "normal",
          undefined,
          `kiotviet-product-sync:${item.familyKey}`,
        );
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") failed++;
      else if (result.value.deduplicated) deduplicated++;
      else queued++;
    }
  }
  return { queued, failed, deduplicated };
}

export async function queueKiotVietCatalog(input: { categoryId?: number } = {}) {
  const catalogMetadata: KiotVietProduct[] = [];
  let currentItem = 0;
  let total = 0;
  while (currentItem === 0 || currentItem < total) {
    const page = await getKiotVietProducts({
      categoryId: input.categoryId,
      currentItem,
      pageSize: KIOTVIET_PAGE_SIZE,
      includeInventory: false,
    });
    total = page.total;
    catalogMetadata.push(
      ...page.data.map((product) => ({
        id: product.id,
        code: product.code,
        name: "",
        masterProductId: product.masterProductId,
        hasVariants: product.hasVariants,
        isActive: product.isActive,
        allowsSale: product.allowsSale,
      })),
    );
    currentItem += page.pageSize || KIOTVIET_PAGE_SIZE;
  }
  const selection = selectKiotVietSyncCandidates(catalogMetadata);
  const result = await enqueueKiotVietProductSyncJobs(
    selection.candidates,
    input.categoryId ? { categoryId: input.categoryId } : {},
  );
  return {
    total,
    queued: result.queued,
    skipped: selection.skipped + result.deduplicated,
    failed: result.failed,
  };
}

export async function resolveSelectedKiotVietProducts(productIds: number[]) {
  const products: KiotVietProduct[] = [];
  let failed = 0;
  const uniqueIds = [...new Set(productIds)];
  for (let start = 0; start < uniqueIds.length; start += PRODUCT_SYNC_BATCH_SIZE) {
    const results = await Promise.allSettled(
      uniqueIds.slice(start, start + PRODUCT_SYNC_BATCH_SIZE).map(getKiotVietProduct),
    );
    for (const result of results)
      if (result.status === "fulfilled") products.push(result.value);
      else failed++;
  }
  const selection = selectKiotVietSyncCandidates(products);
  return {
    candidates: selection.candidates,
    skipped: selection.skipped + (productIds.length - uniqueIds.length),
    failed,
  };
}
