import { requestFulfillmentInvoice, processFulfillmentInvoice, reconcileFulfillmentInvoices } from "@/lib/sync/fulfillment-invoice";
import type { Job } from "bullmq";
import {
  isManualReviewError,
  PermanentError,
  ValidationError,
} from "@/lib/errors";
import type { SyncJobPayload } from "./jobs";
import { webhooksRepository } from "@/repositories/webhooks";
import { syncInventoryNotification } from "@/lib/sync/inventory-sync";
import {
  syncDeletedKiotVietProducts,
  syncKiotVietProductToShopify,
} from "@/lib/sync/kiotviet-product-sync";
import type {
  KiotVietStockNotification,
  KiotVietWebhookPayload,
} from "@/lib/kiotviet/types";
import type { ShopifyOrderWebhook } from "@/types/shopify";
import {
  cancelShopifyOrder,
  syncKiotVietInvoice,
  syncKiotVietOrderCancellation,
  syncShopifyOrder,
} from "@/lib/sync/order-sync";
import { syncShopifyCustomer } from "@/lib/sync/customer-sync";
import { initializeProductMappings } from "@/lib/sync/product-sync";
import { query } from "@/lib/db/client";
import { notify } from "@/lib/notifications/service";
import {
  cleanupOldData,
  reconcileInventoryPage,
} from "@/lib/sync/reconciliation";
import {
  reconcileKiotVietReturns,
  syncKiotVietReturn,
} from "@/lib/sync/return-sync";
import { syncKiotVietCategoryToShopify } from "@/lib/sync/category-sync";
import { normalizeSku } from "@/lib/sync/mappings";
import { admitInventoryReconciliation } from "@/repositories/inventory-reconciliation";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import {
  disabledSyncForJob,
  isSyncGatedJob,
  type SynchronizationSettings,
} from "@/lib/settings/sync-settings";
import { getSyncSettings } from "@/lib/sync/sync-settings";

export interface SkippedJobResult {
  skipped: true;
  reason: string;
}

function isoTime(value: unknown) {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new ValidationError("Webhook payload is invalid");
  return value as Record<string, unknown>;
}

function productIds(payload: KiotVietWebhookPayload): number[] {
  const ids = new Set<number>();
  for (const notification of payload.Notifications ?? [])
    for (const value of notification.Data ?? []) {
      const item = recordPayload(value);
      const id = Number(item.ProductId ?? item.productId ?? item.Id ?? item.id);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  if (!ids.size)
    throw new ValidationError(
      "KiotViet product webhook contains no product ID",
    );
  return [...ids];
}

function addDeleteIds(value: unknown, ids: Set<number>): void {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    const id =
      typeof candidate === "number" || typeof candidate === "string"
        ? Number(candidate)
        : Number.NaN;
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
}

export function deletedProductReferences(
  payload: KiotVietWebhookPayload,
): Array<{ id?: number; code?: string }> {
  const ids = new Set<number>();
  const codes = new Map<string, string>();
  addDeleteIds(payload.RemoveId, ids);
  addDeleteIds(payload.removeId, ids);
  for (const notification of payload.Notifications ?? []) {
    addDeleteIds(notification.RemoveId, ids);
    addDeleteIds(notification.removeId, ids);
    for (const value of notification.Data ?? []) {
      if (typeof value === "number" || typeof value === "string") {
        addDeleteIds(value, ids);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const directId = Number(
        item.ProductId ?? item.productId ?? item.Id ?? item.id,
      );
      if (Number.isSafeInteger(directId) && directId > 0) ids.add(directId);
      addDeleteIds(item.RemoveId, ids);
      addDeleteIds(item.removeId, ids);
      const code = String(
        item.ProductCode ?? item.productCode ?? item.Code ?? item.code ?? item.Sku ?? item.sku ?? "",
      ).trim();
      const normalized = normalizeSku(code);
      if (normalized && !codes.has(normalized)) codes.set(normalized, code);
    }
  }
  if (!ids.size && !codes.size)
    throw new ValidationError(
      "KiotViet product delete webhook contains no product ID or code",
    );
  return [
    ...[...ids].map((id) => ({ id })),
    ...[...codes.values()].map((code) => ({ code })),
  ];
}

function productPriceOverrides(
  payload: KiotVietWebhookPayload,
): Map<number, number> {
  const prices = new Map<number, number>();
  for (const notification of payload.Notifications ?? [])
    for (const value of notification.Data ?? []) {
      const item = recordPayload(value);
      const id = Number(item.ProductId ?? item.productId);
      const price = Number(item.Price ?? item.price);
      if (
        Number.isSafeInteger(id) &&
        id > 0 &&
        Number.isFinite(price) &&
        price >= 0
      )
        prices.set(id, price);
    }
  return prices;
}

/**
 * Sync direction settings are checked here, when the job runs, so jobs queued
 * before a direction was disabled cannot bypass it. Only the affected job type
 * is skipped; the worker keeps processing everything else.
 */
async function skipDisabledJob(
  job: Job<SyncJobPayload>,
): Promise<{ settings?: SynchronizationSettings; skipped?: SkippedJobResult }> {
  if (!isSyncGatedJob(job.name)) return {};
  const settings = await getSyncSettings();
  const disabled = disabledSyncForJob(job.name, settings);
  if (!disabled) return { settings };
  await log("info", "Synchronization direction disabled; job skipped", {
    action: "sync_direction_disabled",
    reason: disabled.reason,
    setting: disabled.setting,
    jobType: job.name,
    eventId: job.data.eventId,
    jobId: typeof job.data.auditJobId === "string" ? job.data.auditJobId : undefined,
  });
  if (job.data.eventId)
    await webhooksRepository.markIgnored(job.data.eventId, disabled.reason);
  return { settings, skipped: { skipped: true, reason: disabled.reason } };
}

export async function processSyncJob(
  job: Job<SyncJobPayload>,
): Promise<SkippedJobResult | undefined> {
  const gate = await skipDisabledJob(job);
  if (gate.skipped) return gate.skipped;
  const inventoryOptions = {
    conflictStrategy: gate.settings?.inventoryConflictStrategy,
  };
  const event = job.data.eventId
    ? await webhooksRepository.get(job.data.eventId)
    : undefined;
  const payload = event?.payload;
  const orderContext = {
    jobType: job.name,
    eventId: job.data.eventId,
    jobId: typeof job.data.auditJobId === "string" ? job.data.auditJobId : undefined,
  };
  switch (job.name) {
    case "kiotviet_inventory_to_shopify": {
      const body = payload as unknown as KiotVietWebhookPayload;
      for (const notification of body.Notifications ?? [])
        for (const item of notification.Data ?? []) {
          await syncInventoryNotification(
            item as KiotVietStockNotification,
            String(job.data.auditJobId),
            { ...inventoryOptions, refreshFromKiotViet: true },
          );
        }
      break;
    }
    case "kiotviet_product_to_shopify": {
      if (job.data.productId) {
        await syncKiotVietProductToShopify(
          Number(job.data.productId),
          String(job.data.auditJobId),
        );
        break;
      }
      const body = payload as unknown as KiotVietWebhookPayload;
      if (String(event?.event_type ?? "").startsWith("product.delete"))
        await syncDeletedKiotVietProducts(
          deletedProductReferences(body),
          String(job.data.auditJobId),
        );
      else {
        const priceOverrides = String(event?.event_type ?? "").startsWith(
          "pricebookdetail.update",
        )
          ? productPriceOverrides(body)
          : new Map<number, number>();
        for (const id of productIds(body))
          await syncKiotVietProductToShopify(
            id,
            String(job.data.auditJobId),
            priceOverrides,
          );
      }
      break;
    }
    case "kiotviet_category_to_shopify": {
      const body = payload as unknown as KiotVietWebhookPayload,
        ids = new Set<number>();
      for (const notification of body.Notifications ?? [])
        for (const value of notification.Data ?? []) {
          const item = recordPayload(value),
            id = Number(
              item.CategoryId ?? item.categoryId ?? item.Id ?? item.id,
            );
          if (Number.isSafeInteger(id) && id > 0) ids.add(id);
        }
      if (!ids.size)
        throw new ValidationError(
          "KiotViet category webhook contains no category ID",
        );
      for (const id of ids)
        await syncKiotVietCategoryToShopify(id, String(job.data.auditJobId));
      break;
    }
    case "kiotviet_order_to_shopify": {
      const body = payload as unknown as KiotVietWebhookPayload;
      for (const notification of body.Notifications ?? [])
        for (const item of notification.Data ?? []) {
          await syncKiotVietOrderCancellation(recordPayload(item));
        }
      break;
    }
    case "kiotviet_invoice_to_shopify": {
      if (job.data.invoiceId) {
        const { getKiotVietInvoice } = await import("@/lib/kiotviet/returns");
        await syncKiotVietInvoice(
          await getKiotVietInvoice(Number(job.data.invoiceId)),
        );
        break;
      }
      const body = payload as unknown as KiotVietWebhookPayload;
      for (const notification of body.Notifications ?? [])
        for (const item of notification.Data ?? [])
          await syncKiotVietInvoice(recordPayload(item));
      break;
    }
    case "shopify_order_create":
    case "shopify_order_update":
      if (job.data.eventId && !event)
        throw new ValidationError(
          `Webhook event ${job.data.eventId} for ${job.name} no longer exists`,
        );
      await syncShopifyOrder(
        payload as unknown as ShopifyOrderWebhook,
        orderContext,
      );
      break;
    case "shopify_order_cancel":
      await cancelShopifyOrder(payload as unknown as ShopifyOrderWebhook);
      break;
    case "shopify_customer_to_kiotviet": {
      const settings = await query<{ value: { syncCustomers?: boolean } }>(
        "SELECT value FROM system_settings WHERE key='orders'",
      );
      if (settings[0]?.value?.syncCustomers === false) {
        await log("info", "Shopify customer webhook ignored", {
          action: "customer_webhook_ignored",
          reason: "customer_sync_disabled",
          eventId: job.data.eventId,
        });
        break;
      }
      await syncShopifyCustomer(
        recordPayload(payload) as unknown as Parameters<
          typeof syncShopifyCustomer
        >[0],
      );
      break;
    }
    case "product_mapping_scan":
    case "full_product_sync":
      await initializeProductMappings();
      break;
    case "app_uninstalled":
    case "webhook_recovery":
      if (event?.event_type === "app/uninstalled") {
        await query(
          "UPDATE integrations SET status='disconnected',updated_at=now() WHERE provider='shopify'",
        );
        await notify(
          "critical",
          "Shopify app uninstalled",
          "Shopify synchronization has been disabled",
        );
      }
      break;
    case "shopify_fulfillment":
      // The webhook's arrival time starts the invoice latency clock (SLO: 95% within 60 s).
      await requestFulfillmentInvoice(String(recordPayload(payload).order_id ?? job.data.entityId ?? ""),
        { receivedAt: isoTime(event?.received_at) });
      break;
    case "shopify_invoice_create":
      await processFulfillmentInvoice(String(job.data.entityId), {
        receivedAt: isoTime(job.data.receivedAt), admittedAt: isoTime(job.data.admittedAt),
      });
      break;
    case "fulfillment_invoice_reconciliation":
      await reconcileFulfillmentInvoices();
      break;
    case "kiotviet_invoice_index": {
      // Read-only copy of KiotViet invoices; only kept current while invoicing is configured.
      const orders = (await query<{ value: Record<string, unknown> }>("SELECT value FROM system_settings WHERE key='orders'"))[0]?.value ?? {};
      const invoicing = orders.autoInvoice === true || ["shopify_fulfilled", "shopify_paid"].includes(String(orders.invoiceCreationTrigger));
      if (!invoicing) break;
      const { advanceInvoiceIndex, getInvoiceIndexHealth, withInvoiceIndexLease } = await import("@/lib/kiotviet/invoice-index");
      // At most 30 pages per run and one run at a time keeps KiotViet requests bounded.
      const runStarted = performance.now();
      const progress = await withInvoiceIndexLease(`job-${String(job.data.auditJobId ?? job.id)}`,
        () => advanceInvoiceIndex({ maxPages: 30, deadlineMs: 50_000 }));
      if (progress)
        await log("info", "KiotViet invoice index run", {
          action: "invoice_index_run", provider: "kiotviet", durationMs: Math.round(performance.now() - runStarted),
          pages: progress.pages, scanned: progress.scanned, total: progress.total, current: progress.current, error: progress.error ?? null,
        });
      if (!progress) {
        await log("info", "KiotViet invoice index run skipped; another run holds the lease", { action: "invoice_index_overlap_skipped", provider: "kiotviet" });
        break;
      }
      if (progress.current && progress.currentAsOf) {
        // Invoice jobs deferred while duplicate detection was inconclusive run again now.
        const { readmitIndexDeferredInvoices } = await import("@/lib/sync/fulfillment-invoice");
        await readmitIndexDeferredInvoices(progress.currentAsOf);
      } else {
        const health = await getInvoiceIndexHealth();
        if (health.stale)
          await log("warn", "KiotViet invoice index is stale", {
            action: "invoice_index_stale", provider: "kiotviet", scanned: health.scanned, total: health.total,
            currentAsOf: health.currentAsOf, error: progress.error ?? health.lastError,
          });
      }
      break;
    }
    case "shopify_refund":
    case "shopify_product_to_kiotviet":
      throw new PermanentError(
        `${job.name} requires manual review because the provider operation is not safely supported by the configured mapping`,
      );
    case "kiotviet_return_reconciliation":
      await reconcileKiotVietReturns();
      break;
    case "kiotviet_return_to_shopify":
      await syncKiotVietReturn(Number(job.data.returnId));
      break;
    case "inventory_reconciliation":
    case "full_inventory_sync": {
      // Drain jobs created by the old webhook mapping without starting a scan.
      if (job.data.eventId) {
        await log("info", "Webhook reconciliation job ignored", {
          action: "inventory_webhook_ignored", reason: "scheduled_reconciliation_only",
          eventId: job.data.eventId,
        });
        break;
      }
      const admission = await admitInventoryReconciliation(
        job.name, job.data, "low", getEnv().JOB_MAX_ATTEMPTS,
        typeof job.data.auditJobId === "string" ? job.data.auditJobId : undefined,
      );
      if (admission.deduplicated) {
        await log("info", "Inventory reconciliation already pending or processing", {
          action: "inventory_reconciliation_ignored", reason: "chain_already_active",
          jobId: job.data.auditJobId,
        });
        break;
      }
      await reconcileInventoryPage(
        Number(job.data.currentItem ?? 0),
        String(job.data.auditJobId),
        admission.payload.reconciliationChainId,
        { ...inventoryOptions, refreshFromKiotViet: true },
      );
      break;
    }
    case "cleanup_old_data":
      await cleanupOldData();
      break;
    case "full_order_reconciliation":
      throw new PermanentError(
        "Order reconciliation requires a configured date range and must be initiated from manual review",
      );
    default:
      throw new PermanentError(`Unsupported job type: ${job.name}`);
  }
  if (job.data.eventId)
    await webhooksRepository.markProcessed(job.data.eventId);
  return undefined;
}

export function isManualReview(error: unknown) {
  return isManualReviewError(error);
}
