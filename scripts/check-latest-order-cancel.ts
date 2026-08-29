import { query } from "../lib/db/client";
import { kiotVietClient } from "../lib/kiotviet/client";

type Mapping = {
  shopify_order_id: string;
  shopify_order_number: string;
  kiotviet_order_id: string;
  kiotviet_order_code: string;
  status: string;
  sync_status: string;
  updated_at: string;
};

async function main() {
  const mappings = await query<Mapping>(
    "SELECT shopify_order_id,shopify_order_number,kiotviet_order_id,kiotviet_order_code,status,sync_status,updated_at FROM order_mappings ORDER BY updated_at DESC LIMIT 5",
  );
  const jobs = await query(
    "SELECT id,type,status,error,attempts,created_at,completed_at FROM sync_jobs WHERE type='shopify_order_cancel' ORDER BY created_at DESC LIMIT 5",
  );
  const webhooks = await query(
    "SELECT webhook_id,status,error,received_at,processed_at FROM webhook_events WHERE provider='shopify' AND event_type='orders/cancelled' ORDER BY received_at DESC LIMIT 5",
  );
  const kiotOrders = [];
  for (const mapping of mappings) {
    try {
      const order = await kiotVietClient.get<{ id: number; code: string; status: number; statusValue?: string }>(
        `/orders/${mapping.kiotviet_order_id}`,
      );
      kiotOrders.push({ mapping: mapping.kiotviet_order_code, id: order.id, code: order.code, status: order.status, statusValue: order.statusValue });
    } catch (error) {
      kiotOrders.push({ mapping: mapping.kiotviet_order_code, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify({ mappings, jobs, webhooks, kiotOrders }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
