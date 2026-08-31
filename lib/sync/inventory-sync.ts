import { ConflictError, MappingError } from "@/lib/errors";
import { normalizeSku } from "./mappings";
import { mappingsRepository } from "@/repositories/mappings";
import { query } from "@/lib/db/client";
import {
  getShopifyInventory,
  setShopifyInventory,
} from "@/lib/shopify/inventory";
import { getActiveShopifyLocations } from "@/lib/shopify/locations";
import { log } from "@/lib/logger";
import type { KiotVietStockNotification } from "@/lib/kiotviet/types";
export function calculateInventory(
  onHand: number,
  reserved = 0,
  safetyStock = 0,
  allowsNegative = false,
) {
  const value = Math.floor(onHand - reserved - safetyStock);
  return allowsNegative ? value : Math.max(0, value);
}
export async function syncInventoryNotification(
  notification: KiotVietStockNotification,
  jobId?: string,
) {
  const sku = normalizeSku(notification.ProductCode);
  if (!sku) throw new MappingError("Inventory event has an empty SKU");
  const mappings = await mappingsRepository.findBySku(sku);
  if (mappings.length !== 1)
    throw mappings.length > 1
      ? new ConflictError(`Duplicate mapping for SKU ${sku}`)
      : new MappingError(`No mapping for SKU ${sku}`);
  const mapping = mappings[0];
  if (!mapping.shopify_inventory_item_id)
    throw new MappingError(`Mapping ${sku} has no Shopify inventory item`);
  let locations = await query<{
    shopify_location_id: string;
    safety_stock: string;
    created?: boolean;
  }>(
    "SELECT shopify_location_id,safety_stock::text FROM branch_location_mappings WHERE kiotviet_branch_id=$1 AND enabled=true",
    [notification.BranchId],
  );
  if (!locations.length) {
    const activeLocations = await getActiveShopifyLocations();
    if (!activeLocations.length)
      throw new MappingError(
        `No active Shopify locations exist for KiotViet branch ${notification.BranchId}`,
      );
    if (activeLocations.length > 1)
      throw new MappingError(
        `KiotViet branch ${notification.BranchId} must be mapped manually because Shopify has multiple active locations`,
      );

    const activeLocation = activeLocations[0];
    const inserted = await query<{
      shopify_location_id: string;
      safety_stock: string;
      created?: boolean;
    }>(
      `INSERT INTO branch_location_mappings(
        kiotviet_branch_id,kiotviet_branch_name,shopify_location_id,
        shopify_location_name,enabled,safety_stock
      ) VALUES($1,$2,$3,$4,true,0)
      ON CONFLICT(kiotviet_branch_id,shopify_location_id) DO NOTHING
      RETURNING shopify_location_id,safety_stock::text,true AS created`,
      [
        notification.BranchId,
        notification.BranchName || String(notification.BranchId),
        activeLocation.id,
        activeLocation.name,
      ],
    );
    locations = inserted;
    if (!locations.length) {
      const existing = await query<{
        shopify_location_id: string;
        safety_stock: string;
        enabled: boolean;
      }>(
        `SELECT shopify_location_id,safety_stock::text,enabled
        FROM branch_location_mappings
        WHERE kiotviet_branch_id=$1 AND shopify_location_id=$2`,
        [notification.BranchId, activeLocation.id],
      );
      if (!existing.length)
        throw new MappingError(
          `Unable to create Shopify location mapping for KiotViet branch ${notification.BranchId}`,
        );
      if (!existing[0].enabled)
        throw new MappingError(
          `Shopify location mapping for KiotViet branch ${notification.BranchId} is disabled and must be enabled manually`,
        );
      locations = existing;
    }
    if (inserted.length)
      await log("info", "Automatic branch/location mapping created", {
        action: "auto_map_branch_location",
        provider: "shopify",
        entityType: "branch_location_mapping",
        entityId: String(notification.BranchId),
        kiotVietBranchId: notification.BranchId,
        shopifyLocationId: activeLocation.id,
        jobId,
      });
  }
  for (const location of locations) {
    const expected = calculateInventory(
      notification.OnHand,
      notification.Reserved,
      Number(location.safety_stock),
    );
    const current = await getShopifyInventory(
      mapping.shopify_inventory_item_id,
      location.shopify_location_id,
    );
    if (current !== expected)
      await setShopifyInventory(
        mapping.shopify_inventory_item_id,
        location.shopify_location_id,
        expected,
        current,
      );
    await query(
      "INSERT INTO inventory_snapshots(sku,branch_id,shopify_location_id,kiotviet_quantity,shopify_quantity,expected_shopify_quantity,difference) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        sku,
        notification.BranchId,
        location.shopify_location_id,
        notification.OnHand,
        current,
        expected,
        current - expected,
      ],
    );
    await log(
      "info",
      current === expected
        ? "Inventory already reconciled"
        : "Shopify inventory updated",
      {
        action: "update_shopify_inventory",
        provider: "shopify",
        entityType: "inventory",
        entityId: sku,
        sku,
        previous: current,
        next: expected,
        jobId,
      },
    );
  }
}
