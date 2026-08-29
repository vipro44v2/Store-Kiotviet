import type { Job } from "bullmq";
import { PermanentError, MappingError, ConflictError, ValidationError } from "@/lib/errors";
import type { SyncJobPayload } from "./jobs";
import { webhooksRepository } from "@/repositories/webhooks";
import { syncInventoryNotification } from "@/lib/sync/inventory-sync";
import { syncDeletedKiotVietProducts, syncKiotVietProductToShopify } from "@/lib/sync/kiotviet-product-sync";
import type { KiotVietStockNotification, KiotVietWebhookPayload } from "@/lib/kiotviet/types";
import type { ShopifyOrderWebhook } from "@/types/shopify";
import { cancelShopifyOrder, syncKiotVietInvoice, syncKiotVietOrderCancellation, syncShopifyOrder } from "@/lib/sync/order-sync";
import { syncShopifyCustomer } from "@/lib/sync/customer-sync";
import { initializeProductMappings } from "@/lib/sync/product-sync";
import { query } from "@/lib/db/client";
import { notify } from "@/lib/notifications/service";
import { cleanupOldData, reconcileInventoryPage } from "@/lib/sync/reconciliation";
import { reconcileKiotVietReturns, syncKiotVietReturn } from "@/lib/sync/return-sync";

function recordPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new ValidationError("Webhook payload is invalid");
  return value as Record<string, unknown>;
}

function productIds(payload: KiotVietWebhookPayload): number[] {
  const ids = new Set<number>();
  for (const notification of payload.Notifications ?? []) for (const value of notification.Data ?? []) {
    const item = recordPayload(value);
    const id = Number(item.ProductId ?? item.productId ?? item.Id ?? item.id);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  if (!ids.size) throw new ValidationError("KiotViet product webhook contains no product ID");
  return [...ids];
}

function deletedProductIds(payload: KiotVietWebhookPayload): number[] {
  const ids = new Set<number>([...(payload.RemoveId ?? []), ...(payload.removeId ?? [])].map(Number));
  for (const notification of payload.Notifications ?? []) {
    for (const id of [...(notification.RemoveId ?? []), ...(notification.removeId ?? [])]) ids.add(Number(id));
    for (const value of notification.Data ?? []) {
      const item = recordPayload(value);
      const values = item.RemoveId ?? item.removeId;
      if (Array.isArray(values)) for (const id of values) ids.add(Number(id));
    }
  }
  const valid = [...ids].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!valid.length) throw new ValidationError("KiotViet product delete webhook contains no product ID");
  return valid;
}

function productPriceOverrides(payload: KiotVietWebhookPayload): Map<number, number> {
  const prices = new Map<number, number>();
  for (const notification of payload.Notifications ?? []) for (const value of notification.Data ?? []) {
    const item = recordPayload(value);
    const id = Number(item.ProductId ?? item.productId);
    const price = Number(item.Price ?? item.price);
    if (Number.isSafeInteger(id) && id > 0 && Number.isFinite(price) && price >= 0) prices.set(id, price);
  }
  return prices;
}

export async function processSyncJob(job: Job<SyncJobPayload>) {
  const event = job.data.eventId ? await webhooksRepository.get(job.data.eventId) : undefined;
  const payload = event?.payload;
  switch (job.name) {
    case "kiotviet_inventory_to_shopify": {
      const body = payload as unknown as KiotVietWebhookPayload;
      for (const notification of body.Notifications ?? []) for (const item of notification.Data ?? []) {
        await syncInventoryNotification(item as KiotVietStockNotification, String(job.data.auditJobId));
      }
      break;
    }
    case "kiotviet_product_to_shopify": {
      if(job.data.productId){await syncKiotVietProductToShopify(Number(job.data.productId),String(job.data.auditJobId));break;}
      const body = payload as unknown as KiotVietWebhookPayload;
      if (String(event?.event_type ?? "").startsWith("product.delete")) await syncDeletedKiotVietProducts(deletedProductIds(body), String(job.data.auditJobId));
      else {
        const priceOverrides = String(event?.event_type ?? "").startsWith("pricebookdetail.update") ? productPriceOverrides(body) : new Map<number, number>();
        for (const id of productIds(body)) await syncKiotVietProductToShopify(id, String(job.data.auditJobId), priceOverrides);
      }
      break;
    }
    case "kiotviet_order_to_shopify": {
      const body = payload as unknown as KiotVietWebhookPayload;
      for (const notification of body.Notifications ?? []) for (const item of notification.Data ?? []) {
        await syncKiotVietOrderCancellation(recordPayload(item));
      }
      break;
    }
    case "kiotviet_invoice_to_shopify": {
      if(job.data.invoiceId){const {getKiotVietInvoice}=await import("@/lib/kiotviet/returns");await syncKiotVietInvoice(await getKiotVietInvoice(Number(job.data.invoiceId)));break;}
      const body=payload as unknown as KiotVietWebhookPayload;
      for(const notification of body.Notifications??[])for(const item of notification.Data??[])await syncKiotVietInvoice(recordPayload(item));
      break;
    }
    case "shopify_order_create":
    case "shopify_order_update":
      await syncShopifyOrder(payload as unknown as ShopifyOrderWebhook);
      break;
    case "shopify_order_cancel":
      await cancelShopifyOrder(payload as unknown as ShopifyOrderWebhook);
      break;
    case "shopify_customer_to_kiotviet":
      await syncShopifyCustomer(recordPayload(payload) as unknown as Parameters<typeof syncShopifyCustomer>[0]);
      break;
    case "product_mapping_scan":
    case "full_product_sync":
      await initializeProductMappings();
      break;
    case "app_uninstalled":
    case "webhook_recovery":
      if (event?.event_type === "app/uninstalled") {
        await query("UPDATE integrations SET status='disconnected',updated_at=now() WHERE provider='shopify'");
        await notify("critical", "Shopify app uninstalled", "Shopify synchronization has been disabled");
      }
      break;
    case "shopify_refund":
    case "shopify_fulfillment":
    case "shopify_product_to_kiotviet":
      throw new PermanentError(`${job.name} requires manual review because the provider operation is not safely supported by the configured mapping`);
    case "kiotviet_return_reconciliation":
      await reconcileKiotVietReturns();
      break;
    case "kiotviet_return_to_shopify":
      await syncKiotVietReturn(Number(job.data.returnId));
      break;
    case "inventory_reconciliation":
    case "full_inventory_sync":
      await reconcileInventoryPage(Number(job.data.currentItem ?? 0), String(job.data.auditJobId));
      break;
    case "cleanup_old_data":
      await cleanupOldData();
      break;
    case "full_order_reconciliation":
      throw new PermanentError("Order reconciliation requires a configured date range and must be initiated from manual review");
    default:
      throw new PermanentError(`Unsupported job type: ${job.name}`);
  }
  if (job.data.eventId) await webhooksRepository.markProcessed(job.data.eventId);
}

export function isManualReview(error: unknown) {
  return error instanceof PermanentError || error instanceof MappingError || error instanceof ConflictError || error instanceof ValidationError;
}
