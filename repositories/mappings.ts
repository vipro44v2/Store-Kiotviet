import { query, transaction } from "@/lib/db/client";
import { MappingError } from "@/lib/errors";

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
  async listAll() {
    return query<MappingRecord>(
      "SELECT * FROM product_mappings ORDER BY updated_at DESC",
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
  async upsertExact(input: Omit<MappingRecord, "id" | "last_sync_hash">) {
    return transaction(async (client) => {
      const locked = await client.query<MappingRecord>(
        "SELECT * FROM product_mappings WHERE normalized_sku=$1 FOR UPDATE",
        [input.normalized_sku],
      );
      const conflict = locked.rows.find(
        (mapping) =>
          mapping.kiotviet_product_id &&
          mapping.kiotviet_product_id !== input.kiotviet_product_id,
      );
      if (conflict)
        throw new MappingError(
          `SKU ${input.normalized_sku} is already mapped to KiotViet product ${conflict.kiotviet_product_id}`,
        );
      const target =
        locked.rows.find(
          (mapping) =>
            mapping.kiotviet_product_id === input.kiotviet_product_id,
        ) ?? locked.rows.find((mapping) => !mapping.kiotviet_product_id);
      if (target) {
        const updated = await client.query<MappingRecord>(
          `UPDATE product_mappings SET sku=$2,normalized_sku=$3,
            shopify_product_id=$4,shopify_variant_id=$5,
            shopify_inventory_item_id=$6,kiotviet_product_id=$7,
            kiotviet_code=$8,sync_direction=$9,sync_status='mapped',updated_at=now()
           WHERE id=$1 RETURNING *`,
          [
            target.id,
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
        return updated.rows[0];
      }
      const inserted = await client.query<MappingRecord>(
        `INSERT INTO product_mappings(
          sku,normalized_sku,shopify_product_id,shopify_variant_id,
          shopify_inventory_item_id,kiotviet_product_id,kiotviet_code,
          sync_direction,sync_status
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'mapped') RETURNING *`,
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
      return inserted.rows[0];
    });
  },
};
