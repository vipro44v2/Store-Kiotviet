import { createHash } from "node:crypto";
import { getEnv } from "@/lib/env";
import { verifyKiotVietHmac } from "@/lib/security/hmac";
import { sanitizeForLog } from "@/lib/security/sanitize";
import { webhooksRepository } from "@/repositories/webhooks";
import { enqueueJob } from "@/lib/queue/queues";
import { isRedisEnabled } from "@/lib/redis/client";
import { log } from "@/lib/logger";
import type { KiotVietWebhookPayload } from "./types";

function jobForAction(action:string){
  if(action.startsWith("stock.update"))return "kiotviet_inventory_to_shopify" as const;
  if(action.startsWith("order.update"))return "kiotviet_order_to_shopify" as const;
  if(action.startsWith("invoice.update"))return "kiotviet_invoice_to_shopify" as const;
  if(action.startsWith("category.update"))return "kiotviet_category_to_shopify" as const;
  if(action.startsWith("product.")||action.startsWith("pricebookdetail.update"))return "kiotviet_product_to_shopify" as const;
  return undefined;
}

export async function receiveKiotVietWebhook(request:Request){const raw=await request.text();const env=getEnv();if(!verifyKiotVietHmac(raw,request.headers.get("x-hub-signature"),env.KIOTVIET_WEBHOOK_SECRET))return{status:401,body:{success:false,error:"Invalid signature"}};let payload:KiotVietWebhookPayload;try{payload=JSON.parse(raw) as KiotVietWebhookPayload;}catch{return{status:400,body:{success:false,error:"Malformed payload"}};}if(env.NODE_ENV!=="test"&&!isRedisEnabled())return{status:503,body:{success:false,error:"Redis is required for asynchronous webhook processing"}};const action=payload.Notifications?.[0]?.Action||(payload.RemoveId?.length||payload.removeId?.length?"product.delete":"unknown"),webhookId=payload.Id||createHash("sha256").update(raw).digest("hex");void log("info","KiotViet webhook received",{provider:"kiotviet",webhookId,eventType:action,payload:sanitizeForLog(payload)});const safeHeaders=sanitizeForLog(Object.fromEntries(request.headers.entries())) as Record<string,string>;const stored=await webhooksRepository.store("kiotviet",webhookId,action,payload,safeHeaders);const type=jobForAction(action);if(stored.inserted&&type)await enqueueJob("webhooks",type,{eventId:stored.id},"high",`kiotviet-${webhookId}`);return{status:200,body:{success:true,duplicate:!stored.inserted,...(!type?{unsupported:true}: {})}};}
