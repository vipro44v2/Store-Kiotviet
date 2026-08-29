import { query } from "../lib/db/client";

async function main() {
  const webhooks = await query(
    "SELECT webhook_id,event_type,status,payload,error,received_at,processed_at FROM webhook_events WHERE provider='kiotviet' AND event_type LIKE 'order.update%' ORDER BY received_at DESC LIMIT 10",
  );
  const jobs = await query(
    "SELECT id,queue_job_id,type,status,attempts,error,created_at,updated_at,completed_at FROM sync_jobs WHERE type='kiotviet_order_to_shopify' ORDER BY created_at DESC LIMIT 10",
  );
  const mappings = await query(
    "SELECT shopify_order_id,shopify_order_number,kiotviet_order_id,kiotviet_order_code,status,financial_status,sync_status,updated_at FROM order_mappings ORDER BY updated_at DESC LIMIT 15",
  );
  const workers = await query("SELECT worker_id,last_seen_at,status,metadata FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 20");
  console.log(JSON.stringify({ webhooks, jobs, mappings, workers }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
