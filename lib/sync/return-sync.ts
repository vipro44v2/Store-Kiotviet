import { createHash } from "node:crypto";
import { query,transaction } from "@/lib/db/client";
import { MappingError,ValidationError } from "@/lib/errors";
import { getKiotVietInvoice,getKiotVietReturn,getKiotVietReturns } from "@/lib/kiotviet/returns";
import type { KiotVietReturn } from "@/lib/kiotviet/types";
import { enqueueJob } from "@/lib/queue/queues";
import { createShopifyReturnRefund,getShopifyRefundableLines,getShopifyRefundTransactions } from "@/lib/shopify/orders";
import { normalizeSku } from "./mappings";

export function matchReturnLines(returned:KiotVietReturn["returnDetails"],shopify:Array<{id:string;sku?:string;refundableQuantity:number}>){
  const bySku=new Map<string,typeof shopify>();
  for(const line of shopify){const sku=normalizeSku(line.sku??"");if(sku)bySku.set(sku,[...(bySku.get(sku)??[]),line]);}
  return returned.map(line=>{const sku=normalizeSku(line.productCode),matches=bySku.get(sku)??[];if(matches.length!==1)throw new MappingError(`Missing or ambiguous Shopify line for returned SKU ${sku||"(empty)"}`);if(!Number.isInteger(line.quantity)||line.quantity<=0)throw new ValidationError(`Invalid return quantity for SKU ${sku}`);if(line.quantity>matches[0].refundableQuantity)throw new ValidationError(`Return quantity for SKU ${sku} exceeds Shopify refundable quantity`);return{lineItemId:matches[0].id,quantity:line.quantity};});
}
export function findExistingRefund(returned:KiotVietReturn["returnDetails"],refunds:Array<{id:string;refundLineItems:{nodes:Array<{quantity:number;lineItem:{sku?:string}}>} }>){
  return refunds.find(refund=>returned.every(line=>refund.refundLineItems.nodes.filter(item=>normalizeSku(item.lineItem.sku??"")===normalizeSku(line.productCode)).reduce((sum,item)=>sum+item.quantity,0)>=line.quantity));
}
export async function syncKiotVietReturn(returnId:number){return transaction(async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`kiotviet-return:${returnId}`]);
  const existing=await client.query<{shopify_refund_id:string;financial_refund_id:string|null;status:string}>("SELECT shopify_refund_id,financial_refund_id,status FROM refund_mappings WHERE kiotviet_return_id=$1",[returnId]);if(existing.rows[0]?.financial_refund_id||existing.rows[0]?.status==="financial_refunded")return{created:false,reason:"already_financially_refunded"};
  const returned=await getKiotVietReturn(returnId),statusText=String(returned.statusValue??"").toLocaleLowerCase("vi");if(returned.status!==1&&!statusText.includes("hoàn thành"))return{created:false,reason:"return_not_completed"};
  if(!returned.invoiceId)throw new MappingError(`KiotViet return ${returned.code} has no invoice`);const invoice=await getKiotVietInvoice(returned.invoiceId);if(!invoice.orderCode)throw new MappingError(`KiotViet invoice ${invoice.code} has no source order code`);
  const mapped=await client.query<{shopify_order_id:string;kiotviet_order_id:string}>("SELECT shopify_order_id,kiotviet_order_id FROM order_mappings WHERE kiotviet_order_code=$1",[invoice.orderCode]);if(mapped.rowCount!==1)throw new MappingError(`KiotViet order ${invoice.orderCode} is not uniquely mapped to Shopify`);
  const order=await getShopifyRefundableLines(mapped.rows[0].shopify_order_id),prior=findExistingRefund(returned.returnDetails??[],order.refunds);
  const amount=Math.abs(Number(returned.totalPayment))||Math.abs(Number(returned.returnTotal));if(!Number.isFinite(amount)||amount<=0)throw new ValidationError(`KiotViet return ${returned.code} has no refundable payment amount`);const payments=await getShopifyRefundTransactions(mapped.rows[0].shopify_order_id,amount);
  const lines=prior?[]:matchReturnLines(returned.returnDetails??[],order.lineItems.nodes);if(!prior&&!lines.length)throw new ValidationError(`KiotViet return ${returned.code} contains no return lines`);const key=createHash("sha256").update(`kiotviet-financial-return:${returned.id}`).digest("hex"),refund=await createShopifyReturnRefund(mapped.rows[0].shopify_order_id,lines,payments,returned.code,key);
  if(existing.rows[0])await client.query("UPDATE refund_mappings SET financial_refund_id=$2,amount=$3,status='financial_refunded',payload=$4,updated_at=now() WHERE kiotviet_return_id=$1",[returned.id,refund.id,amount,JSON.stringify(returned)]);else await client.query("INSERT INTO refund_mappings(shopify_refund_id,financial_refund_id,shopify_order_id,kiotviet_order_id,kiotviet_return_id,kiotviet_return_code,kiotviet_invoice_id,amount,status,payload) VALUES($1,$1,$2,$3,$4,$5,$6,$7,'financial_refunded',$8)",[refund.id,mapped.rows[0].shopify_order_id,mapped.rows[0].kiotviet_order_id,returned.id,returned.code,returned.invoiceId,amount,JSON.stringify(returned)]);return{created:true,refundId:refund.id,returnCode:returned.code,amount};
});}
export async function reconcileKiotVietReturns(){
  const cursors=await query<{value:{lastModifiedFrom?:string}}>("SELECT value FROM system_settings WHERE key='kiotviet_returns_cursor'"),stored=cursors[0]?.value?.lastModifiedFrom,start=stored?new Date(new Date(stored).getTime()-5*60_000):new Date(Date.now()-7*24*60*60_000);let currentItem=0,total=1,latest=stored??start.toISOString(),queued=0;
  while(currentItem<total){const page=await getKiotVietReturns(start.toISOString(),currentItem,100);total=page.total;for(const item of page.data){const modified=item.modifiedDate??item.returnDate;if(modified&&new Date(modified)>new Date(latest))latest=new Date(modified).toISOString();const synced=await query("SELECT 1 FROM refund_mappings WHERE kiotviet_return_id=$1",[item.id]);if(!synced.length){await enqueueJob("sync","kiotviet_return_to_shopify",{returnId:item.id},"high",`kiotviet-return-${item.id}`);queued++;}}currentItem+=page.pageSize||100;}
  await query("INSERT INTO system_settings(key,value,updated_at) VALUES('kiotviet_returns_cursor',$1,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify({lastModifiedFrom:latest})]);return{queued,lastModifiedFrom:latest};
}
