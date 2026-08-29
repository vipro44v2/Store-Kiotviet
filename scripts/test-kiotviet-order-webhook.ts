import { createHmac, randomUUID } from "node:crypto";
import { getEnv, getPublicAppUrl } from "../lib/env";

async function main() {
  const env = getEnv();
  const completed = process.argv[2] === "completed";
  const body = JSON.stringify({
    Id: `order-${completed ? "completed" : "cancel"}-test-${randomUUID()}`,
    Attempt: 1,
    Notifications: [{
      Action: "order.update.501195938",
      Data: [completed
        ? { Id: 24102572, Code: "DH000009", Status: 3, StatusValue: "Hoàn thành" }
        : { Id: 24126731, Code: "DH000013", Status: 4, StatusValue: "Cancelled" }],
    }],
  });
  const signature = createHmac("sha256", Buffer.from(env.KIOTVIET_WEBHOOK_SECRET, "base64")).update(body).digest("hex");
  const url = `${getPublicAppUrl()}/api/webhooks/kiotviet`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature": signature }, body });
  console.log(JSON.stringify({ url, status: response.status, body: await response.text() }));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
