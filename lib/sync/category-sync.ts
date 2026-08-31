import { getKiotVietCategory } from "@/lib/kiotviet/products";
import {
  categoryCollectionHandle,
  createShopifyManualCollection,
  findShopifyCollectionByHandle,
  getShopifyCollection,
  publishShopifyCollectionToOnlineStore,
  updateShopifyCollectionTitle,
} from "@/lib/shopify/collections";
import { transaction } from "@/lib/db/client";
import { ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";

export async function syncKiotVietCategoryToShopify(
  categoryId: number,
  jobId?: string,
) {
  const category = await getKiotVietCategory(categoryId),
    name = String(category.categoryName ?? category.name ?? "").trim();
  if (!name)
    throw new ValidationError(`KiotViet category ${categoryId} has no name`);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `kiotviet-category:${categoryId}`,
    ]);
    const result = await client.query<{
      shopify_collection_id: string | null;
      category_name: string;
    }>(
      "SELECT shopify_collection_id,category_name FROM category_mappings WHERE kiotviet_category_id=$1",
      [categoryId],
    );
    const mapping = result.rows[0],
      handle = categoryCollectionHandle(categoryId);
    let collection = mapping?.shopify_collection_id
      ? await getShopifyCollection(mapping.shopify_collection_id)
      : undefined;
    if (!collection) collection = await findShopifyCollectionByHandle(handle);
    if (!collection)
      collection = await createShopifyManualCollection(name, handle);
    else if (collection.title !== name)
      collection = await updateShopifyCollectionTitle(collection.id, name);
    await publishShopifyCollectionToOnlineStore(collection.id);
    await client.query(
      "INSERT INTO category_mappings(kiotviet_category_id,category_name,shopify_collection_id,shopify_handle,last_sync_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(kiotviet_category_id) DO UPDATE SET category_name=EXCLUDED.category_name,shopify_collection_id=EXCLUDED.shopify_collection_id,shopify_handle=EXCLUDED.shopify_handle,last_sync_at=now(),updated_at=now()",
      [categoryId, name, collection.id, handle],
    );
    await log("info", "KiotViet category synchronized to Shopify collection", {
      action: "sync_shopify_collection",
      provider: "shopify",
      entityType: "category",
      entityId: String(categoryId),
      jobId,
    });
    return { categoryId, collectionId: collection.id, title: name };
  });
}
