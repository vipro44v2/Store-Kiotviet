import { query } from "../lib/db/client";
import { getEnv, getPublicAppUrl } from "../lib/env";
import { getKiotVietAccessToken } from "../lib/kiotviet/auth";

async function main() {
  const env = getEnv();
  const token = await getKiotVietAccessToken();
  const response = await fetch("https://public.kiotapi.com/webhooks?pageSize=100", {
    headers: { Authorization: `Bearer ${token}`, Retailer: env.KIOTVIET_RETAILER },
  });
  if (!response.ok) throw new Error(`Could not list KiotViet webhooks (${response.status})`);
  const registered = await response.json() as { data?: Array<{ id: number; type: string; url: string; isActive: boolean }> };
  const priceBooksResponse = await fetch("https://public.kiotapi.com/pricebooks?pageSize=100", {
    headers: { Authorization: `Bearer ${token}`, Retailer: env.KIOTVIET_RETAILER },
  });
  const priceBooks = priceBooksResponse.ok ? await priceBooksResponse.json() : { error: await priceBooksResponse.text() };
  const webhooks = await query(
    `SELECT id,webhook_id,event_type,status,error,received_at,processed_at,
      jsonb_array_length(COALESCE(payload->'Notifications','[]'::jsonb)) notifications,
      COALESCE((payload->'Notifications'->0->'Data'->0->>'ProductId'),(payload->'Notifications'->0->'Data'->0->>'Id')) product_id
     FROM webhook_events WHERE provider='kiotviet' AND (event_type LIKE 'product.%' OR event_type='pricebookdetail.update')
     ORDER BY received_at DESC LIMIT 15`,
  );
  const jobs = await query(
    `SELECT j.id,j.type,j.status,j.error,j.attempts,j.created_at,j.completed_at,w.webhook_id,w.event_type
     FROM sync_jobs j LEFT JOIN webhook_events w ON j.payload->>'eventId'=w.id::text
     WHERE j.type='kiotviet_product_to_shopify' ORDER BY j.created_at DESC LIMIT 15`,
  );
  console.log(JSON.stringify({ expectedUrl: `${getPublicAppUrl()}/api/webhooks/kiotviet`, registered: registered.data, priceBooks, webhooks, jobs }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
