export const JOB_TYPES = [
  "shopify_order_create", "shopify_order_update", "shopify_order_cancel", "shopify_refund", "shopify_fulfillment",
  "shopify_product_to_kiotviet", "kiotviet_product_to_shopify", "kiotviet_category_to_shopify", "kiotviet_inventory_to_shopify", "kiotviet_order_to_shopify", "kiotviet_invoice_to_shopify",
  "inventory_reconciliation", "shopify_customer_to_kiotviet", "full_product_sync", "full_inventory_sync",
  "full_order_reconciliation", "kiotviet_return_reconciliation", "kiotviet_return_to_shopify", "product_mapping_scan", "webhook_recovery", "cleanup_old_data",
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type JobPriority = "critical" | "high" | "normal" | "low";
export interface SyncJobPayload { eventId?: string; entityId?: string; sku?: string; [key: string]: unknown }

export const priorityNumber: Record<JobPriority, number> = { critical: 1, high: 3, normal: 5, low: 10 };
export function retryDelay(attempt: number): number { return [60_000, 300_000, 900_000, 3_600_000, 21_600_000][Math.min(Math.max(attempt - 1, 0), 4)]; }
