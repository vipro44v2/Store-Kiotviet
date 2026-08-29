import { query } from "../lib/db/client";
import { kiotVietClient } from "../lib/kiotviet/client";

async function main() {
  const settings=await query("SELECT value FROM system_settings WHERE key='orders'");
  const orderWebhooks = await query<{ id:string; webhook_id:string; event_type:string; status:string; error:string|null; received_at:string; order_id:string; order_name:string; customer_id:string|null }>(
    `SELECT id,webhook_id,event_type,status,error,received_at,payload->>'id' order_id,payload->>'name' order_name,payload->'customer'->>'id' customer_id
     FROM webhook_events WHERE provider='shopify' AND event_type IN ('orders/create','orders/updated') ORDER BY received_at DESC LIMIT 8`,
  );
  const jobs = await query(
    `SELECT j.id,j.type,j.status,j.error,j.attempts,j.created_at,j.completed_at,w.webhook_id,w.payload->>'name' order_name
     FROM sync_jobs j LEFT JOIN webhook_events w ON j.payload->>'eventId'=w.id::text
     WHERE j.type IN ('shopify_order_create','shopify_order_update','shopify_customer_to_kiotviet') ORDER BY j.created_at DESC LIMIT 15`,
  );
  const mappings = await query(
    `SELECT o.shopify_order_id,o.shopify_order_number,o.kiotviet_order_id,o.kiotviet_order_code,o.status,o.sync_status,o.updated_at,
      c.shopify_customer_id,c.kiotviet_customer_id,c.last_sync_at
     FROM order_mappings o LEFT JOIN webhook_events w ON w.provider='shopify' AND w.event_type='orders/create' AND w.payload->>'id'=o.shopify_order_id
     LEFT JOIN customer_mappings c ON c.shopify_customer_id=w.payload->'customer'->>'id'
     ORDER BY o.updated_at DESC LIMIT 8`,
  );
  const kiotOrders=[];
  for(const mapping of mappings as Array<{kiotviet_order_id?:string;kiotviet_order_code?:string}>){
    if(!mapping.kiotviet_order_id)continue;
    try{const order=await kiotVietClient.get<{id:number;code:string;customerId?:number;customerName?:string;status:number;statusValue:string}>(`/orders/${mapping.kiotviet_order_id}`);kiotOrders.push({code:order.code,customerId:order.customerId??null,customerName:order.customerName??null,status:order.status,statusValue:order.statusValue});}
    catch(error){kiotOrders.push({code:mapping.kiotviet_order_code,error:error instanceof Error?error.message:String(error)});}
  }
  console.log(JSON.stringify({settings,orderWebhooks,jobs,mappings,kiotOrders},null,2));
}

main().then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1);});
