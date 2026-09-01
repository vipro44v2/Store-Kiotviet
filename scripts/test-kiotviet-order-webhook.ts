import { createHmac, randomUUID } from "node:crypto";
import { getEnv, getPublicAppUrl } from "../lib/env";

async function main() {
  const env = getEnv();
  const completed = process.argv[2] === "completed";
  const orderId = Number(process.argv[3]);
  const orderCode = process.argv[4]?.trim();
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !orderCode)
    throw new Error(
      "Usage: tsx scripts/test-kiotviet-order-webhook.ts <completed|cancelled> <kiotviet-order-id> <order-code>",
    );
  const body = JSON.stringify({
    Id: `order-${completed ? "completed" : "cancel"}-test-${randomUUID()}`,
    Attempt: 1,
    Notifications: [{
      Action: "order.update",
      Data: [{
        Id: orderId,
        Code: orderCode,
        Status: completed ? 3 : 4,
        StatusValue: completed ? "Completed" : "Cancelled",
      }],
    }],
  });
  const signature = createHmac(
    "sha256",
    Buffer.from(env.KIOTVIET_WEBHOOK_SECRET, "base64"),
  ).update(body).digest("hex");
  const url = `${getPublicAppUrl()}/api/webhooks/kiotviet`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature": signature },
    body,
  });
  console.log(JSON.stringify({ url, status: response.status, body: await response.text() }));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
