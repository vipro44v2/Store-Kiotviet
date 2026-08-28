import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const store = vi.fn();
const enqueue = vi.fn();
vi.mock("@/repositories/webhooks", () => ({ webhooksRepository: { store } }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: enqueue }));

beforeAll(() => {
  process.env.KIOTVIET_WEBHOOK_SECRET = Buffer.from("kiotviet-product-secret").toString("base64");
});

describe("KiotViet product webhook", () => {
  it("queues product changes for Shopify synchronization", async () => {
    store.mockResolvedValueOnce({ id: "event-product-1", inserted: true, status: "received" });
    const body = JSON.stringify({ Id: "kv-product-1", Attempt: 1, Notifications: [{ Action: "product.update", Data: [{ ProductId: 43043436 }] }] });
    const signature = createHmac("sha256", Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!, "base64")).update(body).digest("hex");
    const { receiveKiotVietWebhook } = await import("@/lib/kiotviet/webhooks");
    const result = await receiveKiotVietWebhook(new Request("https://sync.example.com/api/kiotviet/webhooks", { method: "POST", headers: { "x-hub-signature": signature }, body }));
    expect(result.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith("webhooks", "kiotviet_product_to_shopify", { eventId: "event-product-1" }, "high", "kiotviet-kv-product-1");
    expect(store.mock.calls[0][4]["x-hub-signature"]).toBe("[REDACTED]");
  });
});
