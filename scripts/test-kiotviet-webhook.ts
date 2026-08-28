import { createHmac, randomUUID } from "node:crypto";
import { getEnv } from "../lib/env";

async function main() {
  const env = getEnv();
  const baseUrl = (process.argv[2] || env.APP_URL).replace(/\/$/, "");
  if (!env.KIOTVIET_WEBHOOK_SECRET) throw new Error("KIOTVIET_WEBHOOK_SECRET is not configured");
  const body = JSON.stringify({ Id: `local-test-${randomUUID()}`, Attempt: 1, Notifications: [{ Action: "stock.update", Data: [] }] });
  const key = Buffer.from(env.KIOTVIET_WEBHOOK_SECRET, "base64");
  const signature = createHmac("sha256", key).update(body).digest("hex");
  const response = await fetch(`${baseUrl}/api/webhooks/kiotviet`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature": signature }, body });
  const responseBody = await response.text();
  process.stdout.write(`${JSON.stringify({ url: `${baseUrl}/api/webhooks/kiotviet`, status: response.status, body: responseBody })}\n`);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
