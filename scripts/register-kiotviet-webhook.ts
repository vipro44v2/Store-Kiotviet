import { getEnv, getPublicAppUrl } from "../lib/env";
import { getKiotVietAccessToken } from "../lib/kiotviet/auth";
import { closeRedis } from "../lib/redis/client";

interface WebhookRecord {
  id: number;
  type: string;
  url: string;
  isActive: boolean;
}

async function main() {
  const env = getEnv();
  if (!env.KIOTVIET_WEBHOOK_SECRET) throw new Error("KIOTVIET_WEBHOOK_SECRET is not configured");

  const type = process.argv[2] || "stock.update";
  const url = `${getPublicAppUrl()}/api/webhooks/kiotviet`;
  const token = await getKiotVietAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Retailer: env.KIOTVIET_RETAILER,
    "Content-Type": "application/json",
  };

  const listResponse = await fetch("https://public.kiotapi.com/webhooks?pageSize=100", { headers });
  if (!listResponse.ok) throw new Error(`Could not list KiotViet webhooks (${listResponse.status})`);
  const list = await listResponse.json() as { data?: WebhookRecord[] };
  const stale = list.data?.filter((webhook) => webhook.type === type && webhook.url !== url) ?? [];
  for (const webhook of stale) {
    const deleteResponse = await fetch(`https://public.kiotapi.com/webhooks/${webhook.id}`, { method: "DELETE", headers });
    if (!deleteResponse.ok) throw new Error(`Could not remove stale KiotViet webhook ${webhook.id} (${deleteResponse.status})`);
  }
  const existing = list.data?.find((webhook) => webhook.type === type && webhook.url === url);
  if (existing?.isActive) {
    process.stdout.write(`${JSON.stringify({ status: "already_registered", webhook: existing })}\n`);
    return;
  }
  if (existing) {
    const deleteResponse = await fetch(`https://public.kiotapi.com/webhooks/${existing.id}`, { method: "DELETE", headers });
    if (!deleteResponse.ok) throw new Error(`Could not remove inactive KiotViet webhook (${deleteResponse.status})`);
  }

  const response = await fetch("https://public.kiotapi.com/webhooks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      Webhook: {
        Type: type,
        Url: url,
        IsActive: true,
        Description: type === "stock.update" ? "Shopify inventory synchronization" : type === "order.update" ? "Shopify order cancellation synchronization" : "Shopify product synchronization",
        Secret: env.KIOTVIET_WEBHOOK_SECRET,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`KiotViet webhook registration failed (${response.status}): ${body}`);
  process.stdout.write(`${JSON.stringify({ status: "registered", webhook: JSON.parse(body) })}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeRedis());
