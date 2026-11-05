import { withInventoryLock } from "@/lib/db/inventory-lock";
import { ConflictError, MappingError, RetryableError } from "@/lib/errors";
import { normalizeSku } from "./mappings";
import { mappingsRepository } from "@/repositories/mappings";
import { query } from "@/lib/db/client";
import {
  getShopifyInventory,
  ensureShopifyInventoryActive,
  setShopifyInventory,
} from "@/lib/shopify/inventory";
import { getActiveShopifyLocations } from "@/lib/shopify/locations";
import { log } from "@/lib/logger";
import type { KiotVietStockNotification } from "@/lib/kiotviet/types";
import { getKiotVietProduct } from "@/lib/kiotviet/products";
import type { InventoryConflictStrategy } from "@/lib/settings/sync-settings";

export interface InventorySyncOptions {
  /** Defaults to "hold". */
  conflictStrategy?: InventoryConflictStrategy;
  /**
   * Webhooks can arrive out of order, so a stock.update payload may be stale.
   * When set, the current KiotViet on-hand for the branch is read and used
   * instead (it is an absolute value; nothing is subtracted).
   */
  refreshFromKiotViet?: boolean;
}

async function currentKiotVietStock(notification: KiotVietStockNotification, jobId?: string) {
  const product = await getKiotVietProduct(Number(notification.ProductId));
  const current = product.inventories?.find((inventory) => Number(inventory.branchId) === Number(notification.BranchId));
  if (!current || current.onHand == null || !Number.isFinite(Number(current.onHand)))
    throw new RetryableError("Authoritative KiotViet branch stock unavailable; stale webhook ignored");
  const refreshed = { ...notification, OnHand: Number(current.onHand), Reserved: Number(current.reserved ?? notification.Reserved ?? 0) };
  if (refreshed.OnHand !== Number(notification.OnHand))
    await log("info", "Stale KiotViet stock event superseded by current stock", {
      action: "inventory_event_superseded", provider: "kiotviet", entityType: "inventory",
      entityId: notification.ProductCode, branchId: notification.BranchId,
      eventOnHand: notification.OnHand, currentOnHand: refreshed.OnHand, jobId,
    });
  return refreshed;
}
export const SHOPIFY_DEDUCTION_CONFLICT = "inventory_shopify_deduction";

/**
 * KiotViet owns stock, but Shopify deducts `available` itself when an order is
 * placed. If Shopify is now below the last value this app verified, and the
 * KiotViet value would raise it again, KiotViet does not reflect that deduction
 * yet (order not synced, or synced as a KiotViet order that only reserves
 * stock). Writing would restore stock that was already sold.
 */
export function detectUnreflectedShopifyDeduction(
  lastSynced: number | null,
  currentShopify: number,
  expected: number,
) {
  if (lastSynced === null) return null;
  const shopifyDeduction = lastSynced - currentShopify;
  if (shopifyDeduction <= 0 || expected <= currentShopify) return null;
  return {
    lastSynced,
    currentShopify,
    expected,
    shopifyDeduction,
    wouldRestore: Math.min(shopifyDeduction, expected - currentShopify),
  };
}

/** Last quantity this app wrote or verified, ignoring held, failed and unverified snapshots. */
async function lastSyncedShopifyQuantity(sku: string, locationId: string) {
  const rows = await query<{ shopify_quantity: string | null }>(
    "SELECT shopify_quantity::text FROM inventory_snapshots WHERE sku=$1 AND shopify_location_id=$2 AND (status IS NULL OR status='baseline') AND shopify_quantity=expected_shopify_quantity ORDER BY created_at DESC LIMIT 1",
    [sku, locationId],
  );
  const value = rows?.[0]?.shopify_quantity;
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

export function calculateInventory(
  onHand: number,
  _reserved?: number,
  safetyStock = 0,
  allowsNegative = false,
) {
  // Reserved is retained in the signature for existing callers, but does not reduce Shopify stock.
  const value = Math.floor(onHand - safetyStock);
  return allowsNegative ? value : Math.max(0, value);
}
export async function syncInventoryNotification(
  notification: KiotVietStockNotification, jobId?: string, options: InventorySyncOptions = {},
) {
  return withInventoryLock(`inventory:${notification.BranchId}:${notification.ProductId}`,
    () => syncInventoryNotificationLocked(notification, jobId, options));
}

async function syncInventoryNotificationLocked(
  notification: KiotVietStockNotification,
  jobId?: string,
  options: InventorySyncOptions = {},
) {
  if (options.refreshFromKiotViet) notification = await currentKiotVietStock(notification, jobId);
  const sku = normalizeSku(notification.ProductCode);
  if (!sku) throw new MappingError("Inventory event has an empty SKU");
  const mappings = (await mappingsRepository.findBySku(sku)).filter((mapping) => mapping.sync_status !== "archived");
  if (mappings.length !== 1)
    throw mappings.length > 1
      ? new ConflictError(`Duplicate mapping for SKU ${sku}`)
      : new MappingError(`No mapping for SKU ${sku}`);
  const mapping = mappings[0];
  if (mapping.kiotviet_product_id && mapping.kiotviet_product_id !== String(notification.ProductId))
    throw new MappingError(`Inventory event for KiotViet product ${notification.ProductId} does not own SKU ${sku}`);
  if (!mapping.shopify_inventory_item_id)
    throw new MappingError(`Mapping ${sku} has no Shopify inventory item`);
  // shared_branches: other enabled KiotViet branches writing the same Shopify location. Each
  // branch sets the level to its own on-hand, so they would overwrite each other.
  let locations = await query<{
    shopify_location_id: string;
    safety_stock: string;
    created?: boolean;
    shared_branches?: number;
  }>(
    `SELECT shopify_location_id,safety_stock::text,(SELECT count(*) FROM branch_location_mappings o
        WHERE o.shopify_location_id=b.shopify_location_id AND o.enabled AND o.kiotviet_branch_id<>b.kiotviet_branch_id)::int AS shared_branches
      FROM branch_location_mappings b WHERE kiotviet_branch_id=$1 AND enabled=true`,
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
      ) SELECT $1,$2,$3,$4,true,0
      -- Never auto-map a branch onto a location another enabled branch already writes.
      WHERE NOT EXISTS (SELECT 1 FROM branch_location_mappings o WHERE o.shopify_location_id=$3 AND o.enabled AND o.kiotviet_branch_id<>$1)
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
          `Unable to create Shopify location mapping for KiotViet branch ${notification.BranchId}: the only Shopify location may already be mapped to another KiotViet branch (one branch per location); map it manually`,
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
  if (locations.length > 1)
    throw new ConflictError(`KiotViet branch ${notification.BranchId} has multiple enabled Shopify location mappings`);
  const [location] = locations;
  if (Number(location.shared_branches ?? 0) > 0)
    throw new ConflictError(`Shopify location ${location.shopify_location_id} is mapped to KiotViet branch ${notification.BranchId} and ${location.shared_branches} other enabled branch(es); their stock would overwrite each other, so nothing is written (map one branch per location)`);
  const expected = calculateInventory(
    notification.OnHand,
    notification.Reserved,
    Number(location.safety_stock),
  );
  const inventoryItemId = mapping.shopify_inventory_item_id;
  const locationId = location.shopify_location_id;
  const context = { inventoryItemId, locationId, sku, expected, jobId,
    provider: "shopify", entityType: "inventory", entityId: sku };
  let before: number | null = null;
  let after: number | null = null;
  try {
    const initial = await getShopifyInventory(inventoryItemId, locationId);
    before = initial.available;
    const active = await ensureShopifyInventoryActive(inventoryItemId, locationId, { ...context, before, after });
    if (!active.isActive || active.available === null)
      throw new RetryableError("Inventory activation unverified for " + inventoryItemId + " at " + locationId);
    const lastSynced = await lastSyncedShopifyQuantity(sku, locationId);
    const deduction = detectUnreflectedShopifyDeduction(lastSynced, active.available, expected);
    const conflictKey = `${sku}@${locationId}`;
    if (deduction) {
      const strategy = options.conflictStrategy ?? "hold";
      // One open conflict per SKU/location; hourly reconciliation must not pile up duplicates.
      await query(
        `INSERT INTO sync_conflicts(entity_type,entity_key,conflict_type,shopify_value,kiotviet_value)
        SELECT 'inventory',$1,$2,$3,$4
        WHERE NOT EXISTS (SELECT 1 FROM sync_conflicts WHERE entity_type='inventory' AND entity_key=$1 AND conflict_type=$2 AND resolution_status='open')`,
        [
          conflictKey,
          SHOPIFY_DEDUCTION_CONFLICT,
          JSON.stringify({ sku, inventoryItemId, locationId, available: active.available, lastSynced: deduction.lastSynced }),
          JSON.stringify({ productId: notification.ProductId, branchId: notification.BranchId, onHand: notification.OnHand, reserved: notification.Reserved, expected, strategy }),
        ],
      );
      await log("warn", "Shopify inventory deduction is not reflected in KiotViet", {
        ...context, before, after, ...deduction, strategy, action: "inventory_shopify_deduction_detected",
      });
      if (strategy === "hold") {
        await query(
          "INSERT INTO inventory_snapshots(sku,branch_id,shopify_location_id,kiotviet_quantity,shopify_quantity,expected_shopify_quantity,difference,status) VALUES($1,$2,$3,$4,$5,$6,$7,'held')",
          [sku, notification.BranchId, locationId, notification.OnHand, active.available, expected, active.available - expected],
        );
        await log("info", "inventory_set_held", { ...context, before, after: active.available, action: "inventory_set_held" });
        return { status: "held" as const, ...deduction };
      }
    }
    if (active.available !== expected) {
      await log("info", "inventory_set_started", { ...context, before, after, changeFromQuantity: active.available, action: "inventory_set_started" });
      await setShopifyInventory(inventoryItemId, locationId, expected, active.available);
    }
    const verified = await getShopifyInventory(inventoryItemId, locationId);
    after = verified.available;
    await log("info", "inventory_readback", { ...context, before, after, isActive: verified.isActive, onHand: verified.onHand, action: "inventory_readback" });
    await query(
      "INSERT INTO inventory_snapshots(sku,branch_id,shopify_location_id,kiotviet_quantity,shopify_quantity,expected_shopify_quantity,difference) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [sku, notification.BranchId, locationId, notification.OnHand, after, expected, after === null ? null : after - expected],
    );
    if (!verified.isActive || after !== expected)
      throw new RetryableError("Inventory verification failed: " + JSON.stringify({ ...context, before, after, active: verified.isActive }));
    if (!deduction && lastSynced !== null && active.available < lastSynced)
      // KiotViet now reflects the earlier Shopify deduction; close the held conflict.
      await query(
        "UPDATE sync_conflicts SET resolution_status='resolved',resolution=$3,resolved_at=now() WHERE entity_type='inventory' AND entity_key=$1 AND conflict_type=$2 AND resolution_status='open'",
        [conflictKey, SHOPIFY_DEDUCTION_CONFLICT, JSON.stringify({ auto: "kiotviet_reflects_shopify_deduction", expected })],
      );
    await log("info", "inventory_set_completed", { ...context, before, after, action: "inventory_set_completed" });
    return { status: "synced" as const };
  } catch (error) {
    await log("error", "Shopify inventory sync failed", { ...context, before, after, action: "inventory_sync_failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
