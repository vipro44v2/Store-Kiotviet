import { z } from "zod";

/** Stored in system_settings under this key. Safe to import from client components. */
export const SYNC_SETTINGS_KEY = "synchronization";

export interface SyncSettings {
  shopifyOrdersToKiotViet: boolean;
  kiotVietOrderStatusToShopify: boolean;
  kiotVietInventoryToShopify: boolean;
}

/**
 * - hold: never raise Shopify `available` above its current value while Shopify
 *   has deductions (e.g. sales) that KiotViet does not reflect yet; flag a conflict.
 * - kiotviet_wins: legacy behavior, overwrite with KiotViet but still flag the conflict.
 */
export const INVENTORY_CONFLICT_STRATEGIES = ["hold", "kiotviet_wins"] as const;
export type InventoryConflictStrategy = (typeof INVENTORY_CONFLICT_STRATEGIES)[number];

export interface SynchronizationSettings extends SyncSettings {
  /** Shopify orders/cancelled → cancel the KiotViet order. Also requires shopifyOrdersToKiotViet. */
  shopifyOrderCancellationsToKiotViet: boolean;
  inventoryConflictStrategy: InventoryConflictStrategy;
}

/** New installations (written by migration 006 when the database has no prior data). */
export const DEFAULT_SYNC_SETTINGS: SynchronizationSettings = {
  shopifyOrdersToKiotViet: true,
  kiotVietOrderStatusToShopify: false,
  kiotVietInventoryToShopify: true,
  shopifyOrderCancellationsToKiotViet: true,
  inventoryConflictStrategy: "hold",
};

/**
 * Used only when the settings row does not exist, i.e. migration 006 has not run
 * on an existing installation. Matches pre-006 behavior so a code deploy alone
 * never disables an active workflow.
 */
export const LEGACY_SYNC_SETTINGS: SynchronizationSettings = {
  shopifyOrdersToKiotViet: true,
  kiotVietOrderStatusToShopify: true,
  kiotVietInventoryToShopify: true,
  shopifyOrderCancellationsToKiotViet: true,
  inventoryConflictStrategy: "kiotviet_wins",
};

export const synchronizationSettingsSchema = z
  .object({
    shopifyOrdersToKiotViet: z.boolean(),
    kiotVietOrderStatusToShopify: z.boolean(),
    kiotVietInventoryToShopify: z.boolean(),
    shopifyOrderCancellationsToKiotViet: z.boolean(),
    inventoryConflictStrategy: z.enum(INVENTORY_CONFLICT_STRATEGIES),
  })
  .strict();

/** Normalize stored data. Missing or malformed fields fall back to DEFAULT_SYNC_SETTINGS; a missing row uses LEGACY_SYNC_SETTINGS. */
export function parseSyncSettings(value: unknown): SynchronizationSettings {
  if (value === undefined || value === null) return { ...LEGACY_SYNC_SETTINGS };
  const stored = typeof value === "object" ? (value as Record<string, unknown>) : {};
  const flag = (key: keyof SyncSettings | "shopifyOrderCancellationsToKiotViet") =>
    typeof stored[key] === "boolean" ? (stored[key] as boolean) : DEFAULT_SYNC_SETTINGS[key];
  const strategy = stored.inventoryConflictStrategy;
  return {
    shopifyOrdersToKiotViet: flag("shopifyOrdersToKiotViet"),
    kiotVietOrderStatusToShopify: flag("kiotVietOrderStatusToShopify"),
    kiotVietInventoryToShopify: flag("kiotVietInventoryToShopify"),
    shopifyOrderCancellationsToKiotViet: flag("shopifyOrderCancellationsToKiotViet"),
    inventoryConflictStrategy: INVENTORY_CONFLICT_STRATEGIES.includes(strategy as InventoryConflictStrategy)
      ? (strategy as InventoryConflictStrategy)
      : DEFAULT_SYNC_SETTINGS.inventoryConflictStrategy,
  };
}

export interface DisabledSync {
  setting: keyof SynchronizationSettings;
  reason: string;
}

const ORDER_JOBS = new Set(["shopify_order_create", "shopify_order_update"]);
const ORDER_STATUS_JOBS = new Set(["kiotviet_order_to_shopify", "kiotviet_invoice_to_shopify"]);
const INVENTORY_JOBS = new Set(["kiotviet_inventory_to_shopify", "inventory_reconciliation", "full_inventory_sync"]);

export function isSyncGatedJob(type: string) {
  return ORDER_JOBS.has(type) || type === "shopify_order_cancel" ||
    ORDER_STATUS_JOBS.has(type) || INVENTORY_JOBS.has(type);
}

/** Returns why a job must not run, or undefined when its direction is enabled. */
export function disabledSyncForJob(type: string, settings: SynchronizationSettings): DisabledSync | undefined {
  if ((ORDER_JOBS.has(type) || type === "shopify_order_cancel") && !settings.shopifyOrdersToKiotViet)
    return { setting: "shopifyOrdersToKiotViet", reason: "shopify_orders_to_kiotviet_disabled" };
  if (type === "shopify_order_cancel" && !settings.shopifyOrderCancellationsToKiotViet)
    return { setting: "shopifyOrderCancellationsToKiotViet", reason: "shopify_order_cancellations_to_kiotviet_disabled" };
  if (ORDER_STATUS_JOBS.has(type) && !settings.kiotVietOrderStatusToShopify)
    return { setting: "kiotVietOrderStatusToShopify", reason: "kiotviet_order_status_to_shopify_disabled" };
  if (INVENTORY_JOBS.has(type) && !settings.kiotVietInventoryToShopify)
    return { setting: "kiotVietInventoryToShopify", reason: "kiotviet_inventory_to_shopify_disabled" };
  return undefined;
}
