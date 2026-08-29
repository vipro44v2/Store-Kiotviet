import { getKiotVietReturns } from "@/lib/kiotviet/returns";
import { closeDatabase,query } from "@/lib/db/client";
import { closeRedis } from "@/lib/redis/client";
import { getKiotVietInvoice } from "@/lib/kiotviet/returns";
import { getShopifyOrder,getShopifyRefundableLines } from "@/lib/shopify/orders";

async function main(){
  const page=await getKiotVietReturns(new Date(Date.now()-7*24*60*60_000).toISOString(),0,20),rows=[];
  for(const item of page.data){
    const invoice=item.invoiceId?await getKiotVietInvoice(item.invoiceId):undefined;
    const order=invoice?.orderCode?await query<{shopify_order_id:string}>("SELECT shopify_order_id FROM order_mappings WHERE kiotviet_order_code=$1",[invoice.orderCode]):[];
    const refundable=order[0]?await getShopifyRefundableLines(order[0].shopify_order_id):undefined;
    const shopifyOrder=order[0]?await getShopifyOrder(`gid://shopify/Order/${order[0].shopify_order_id}`):undefined;
    const mapping=await query<{shopify_order_id:string}>("SELECT om.shopify_order_id FROM order_mappings om JOIN refund_mappings rm ON rm.kiotviet_order_id=om.kiotviet_order_id WHERE rm.kiotviet_return_id=$1",[item.id]);
    rows.push({id:item.id,code:item.code,invoiceId:item.invoiceId,orderCode:invoice?.orderCode,shopifyOrderId:order[0]?.shopify_order_id,shopifyFinancialStatus:shopifyOrder?.displayFinancialStatus,shopifyCancelledAt:shopifyOrder?.cancelledAt,returnTotal:item.returnTotal,totalPayment:item.totalPayment,status:item.status,statusValue:item.statusValue,modifiedDate:item.modifiedDate,lines:item.returnDetails?.map(line=>({sku:line.productCode,quantity:line.quantity,price:line.price,subTotal:line.subTotal})),refundable:refundable?.lineItems.nodes,alreadySynced:Boolean(mapping.length)});
  }
  const cursor=await query<{value:unknown}>("SELECT value FROM system_settings WHERE key='kiotviet_returns_cursor'");
  const jobs=await query<{type:string;status:string;error:string|null;created_at:string}>("SELECT type,status,error,created_at FROM sync_jobs WHERE type IN ('kiotviet_return_reconciliation','kiotviet_return_to_shopify') ORDER BY created_at DESC LIMIT 10");
  process.stdout.write(`${JSON.stringify({total:page.total,returns:rows,cursor:cursor[0]?.value,recentJobs:jobs},null,2)}\n`);
}
main().finally(async()=>{await closeRedis();await closeDatabase();});
