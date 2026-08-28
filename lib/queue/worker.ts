import type { Job } from "bullmq";
import { PermanentError,MappingError,ConflictError,ValidationError } from "@/lib/errors";
import type { SyncJobPayload } from "./jobs";
import { webhooksRepository } from "@/repositories/webhooks";
import { syncInventoryNotification } from "@/lib/sync/inventory-sync";
import { syncKiotVietProductToShopify } from "@/lib/sync/kiotviet-product-sync";
import type { KiotVietWebhookPayload } from "@/lib/kiotviet/types";
import type { ShopifyOrderWebhook } from "@/types/shopify";
import { syncShopifyOrder,cancelShopifyOrder } from "@/lib/sync/order-sync";
import { syncShopifyCustomer } from "@/lib/sync/customer-sync";
import { initializeProductMappings } from "@/lib/sync/product-sync";
import { query } from "@/lib/db/client";
import { notify } from "@/lib/notifications/service";
import { cleanupOldData,reconcileInventoryPage } from "@/lib/sync/reconciliation";

function recordPayload(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object")throw new ValidationError("Webhook payload is invalid");return value as Record<string,unknown>;}
function productIds(payload:KiotVietWebhookPayload):number[]{const ids=new Set<number>();for(const notification of payload.Notifications??[])for(const value of notification.Data??[]){const item=recordPayload(value),id=Number(item.ProductId??item.productId??item.Id??item.id);if(Number.isSafeInteger(id)&&id>0)ids.add(id);}if(!ids.size)throw new ValidationError("KiotViet product webhook contains no product ID");return [...ids];}

export async function processSyncJob(job:Job<SyncJobPayload>){const event=job.data.eventId?await webhooksRepository.get(job.data.eventId):undefined;const payload=event?.payload;switch(job.name){case"kiotviet_inventory_to_shopify":{const body=payload as unknown as KiotVietWebhookPayload;for(const notification of body.Notifications??[])for(const item of notification.Data??[])await syncInventoryNotification(item,String(job.data.auditJobId));break;}case"kiotviet_product_to_shopify":{const body=payload as unknown as KiotVietWebhookPayload;for(const id of productIds(body))await syncKiotVietProductToShopify(id,String(job.data.auditJobId));break;}case"shopify_order_create":case"shopify_order_update":await syncShopifyOrder(payload as unknown as ShopifyOrderWebhook);break;case"shopify_order_cancel":await cancelShopifyOrder(payload as unknown as ShopifyOrderWebhook);break;case"shopify_customer_to_kiotviet":await syncShopifyCustomer(recordPayload(payload) as unknown as Parameters<typeof syncShopifyCustomer>[0]);break;case"product_mapping_scan":case"full_product_sync":await initializeProductMappings();break;case"app_uninstalled":case"webhook_recovery":if(event?.event_type==="app/uninstalled"){await query("UPDATE integrations SET status='disconnected',updated_at=now() WHERE provider='shopify'");await notify("critical","Shopify app uninstalled","Shopify synchronization has been disabled");}break;case"shopify_refund":case"shopify_fulfillment":case"shopify_product_to_kiotviet":throw new PermanentError(`${job.name} requires manual review because the provider operation is not safely supported by the configured mapping`);case"inventory_reconciliation":case"full_inventory_sync":await reconcileInventoryPage(Number(job.data.currentItem??0),String(job.data.auditJobId));break;case"cleanup_old_data":await cleanupOldData();break;case"full_order_reconciliation":throw new PermanentError("Order reconciliation requires a configured date range and must be initiated from manual review");default:throw new PermanentError(`Unsupported job type: ${job.name}`);}if(job.data.eventId)await webhooksRepository.markProcessed(job.data.eventId);}
export function isManualReview(error:unknown){return error instanceof PermanentError||error instanceof MappingError||error instanceof ConflictError||error instanceof ValidationError;}
