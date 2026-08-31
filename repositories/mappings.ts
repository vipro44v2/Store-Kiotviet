import { query, transaction } from "@/lib/db/client";

export interface MappingRecord {
  id: string;
  sku: string;
  normalized_sku: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_inventory_item_id: string | null;
  kiotviet_product_id: string | null;
  kiotviet_code: string | null;
  sync_direction: string;
  sync_status?: string;
  last_sync_hash: string | null;
}
export const mappingsRepository = {
  async findBySku(normalizedSku: string) {
    return query<MappingRecord>(
      "SELECT * FROM product_mappings WHERE normalized_sku=$1",
      [normalizedSku],
    );
  },
  async list(limit = 200) {
    return query<MappingRecord>(
      "SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT $1",
      [limit],
    );
  },
  async upsert(input: Omit<MappingRecord, "id" | "last_sync_hash">) {
    return transaction(async (client) => {
      const result = await client.query<MappingRecord>(
        `INSERT INTO product_mappings(sku,normalized_sku,shopify_product_id,shopify_variant_id,shopify_inventory_item_id,kiotviet_product_id,kiotviet_code,sync_direction,sync_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'mapped') ON CONFLICT(normalized_sku) WHERE shopify_variant_id IS NOT NULL AND kiotviet_product_id IS NOT NULL
      DO UPDATE SET shopify_product_id=EXCLUDED.shopify_product_id,shopify_variant_id=EXCLUDED.shopify_variant_id,shopify_inventory_item_id=EXCLUDED.shopify_inventory_item_id,kiotviet_product_id=EXCLUDED.kiotviet_product_id,updated_at=now() RETURNING *`,
        [
          input.sku,
          input.normalized_sku,
          input.shopify_product_id,
          input.shopify_variant_id,
          input.shopify_inventory_item_id,
          input.kiotviet_product_id,
          input.kiotviet_code,
          input.sync_direction,
        ],
      );
      return result.rows[0];
    });
  },
};
