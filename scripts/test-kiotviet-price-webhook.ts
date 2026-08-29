import { createHmac, randomUUID } from "node:crypto";
import { getEnv, getPublicAppUrl } from "../lib/env";
import { getKiotVietProduct } from "../lib/kiotviet/products";

async function main() {
  const env = getEnv();
  const productId = Number(process.argv[2] ?? 43043467);
  const current = await getKiotVietProduct(productId);
  const price = process.argv[3] === undefined ? Number(current.basePrice ?? 0) : Number(process.argv[3]);
  const webhookId = `price-test-${randomUUID()}`;
  const body = JSON.stringify({
    Id: webhookId,
    Attempt: 1,
    Notifications: [{ Action: "pricebookdetail.update", Data: [{ PriceBookId: 0, ProductId: productId, Price: price }] }],
  });
  const signature = createHmac("sha256", Buffer.from(env.KIOTVIET_WEBHOOK_SECRET, "base64")).update(body).digest("hex");
  const url = `${getPublicAppUrl()}/api/webhooks/kiotviet`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature": signature }, body });
  console.log(JSON.stringify({ webhookId, productId, price, url, status: response.status, body: await response.text() }));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
