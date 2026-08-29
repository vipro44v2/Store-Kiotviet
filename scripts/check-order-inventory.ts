import { query } from "../lib/db/client";
import { getKiotVietInventory } from "../lib/kiotviet/inventory";
import { getShopifyInventory } from "../lib/shopify/inventory";

async function main() {
  const mappings = await query(
    "SELECT shopify_order_id,shopify_order_number,kiotviet_order_id,kiotviet_order_code,status,financial_status,sync_status,updated_at FROM order_mappings ORDER BY updated_at DESC LIMIT 10",
  );
  const jobs = await query(
    "SELECT id,type,status,error,created_at,completed_at FROM sync_jobs WHERE type IN ('shopify_order_update','shopify_order_cancel') ORDER BY created_at DESC LIMIT 15",
  );
  const productMappings = await query<{
    sku: string;
    shopify_inventory_item_id: string;
    shopify_location_id: string;
    kiotviet_branch_id: string;
  }>(
    "SELECT p.sku,p.shopify_inventory_item_id,b.shopify_location_id,b.kiotviet_branch_id FROM product_mappings p CROSS JOIN branch_location_mappings b WHERE p.normalized_sku=$1 AND b.enabled=true LIMIT 1",
    ["SP000001"],
  );
  const kiotPage = await getKiotVietInventory(0, 100);
  const kiotProduct = kiotPage.data.find((product) => product.code === "SP000001");
  const inventoryMapping = productMappings[0];
  const shopifyAvailable = inventoryMapping
    ? await getShopifyInventory(inventoryMapping.shopify_inventory_item_id, inventoryMapping.shopify_location_id)
    : null;

  console.log(JSON.stringify({ mappings, jobs, kiotProduct, inventoryMapping, shopifyAvailable }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
