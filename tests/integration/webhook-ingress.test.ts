import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
const store = vi.fn(),
  enqueue = vi.fn();
vi.mock("@/repositories/webhooks", () => ({ webhooksRepository: { store } }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: enqueue }));
beforeAll(() => {
  process.env.SHOPIFY_CLIENT_SECRET = "shopify-secret";
  process.env.KIOTVIET_WEBHOOK_SECRET =
    Buffer.from("kiotviet-secret").toString("base64");
});
beforeEach(() => { store.mockReset(); enqueue.mockReset(); });
describe("webhook ingress", () => {
  it("persists and queues a verified Shopify event", async () => {
    store.mockResolvedValueOnce({
      id: "event-1",
      inserted: true,
      status: "received",
    });
    const body = JSON.stringify({ id: 123 }),
      signature = createHmac("sha256", "shopify-secret")
        .update(body)
        .digest("base64");
    const { receiveShopifyWebhook } = await import("@/lib/shopify/webhooks");
    const request = new Request(
      "https://sync.example.com/api/shopify/webhooks/orders_create",
      {
        method: "POST",
        headers: {
          "x-shopify-hmac-sha256": signature,
          "x-shopify-webhook-id": "delivery-1",
          "x-shopify-topic": "orders/create",
        },
        body,
      },
    );
    const result = await receiveShopifyWebhook(request, "orders_create");
    expect(result.status).toBe(200);
    expect(store).toHaveBeenCalledOnce();
    expect(store.mock.calls[0][4]["x-shopify-hmac-sha256"]).toBe("[REDACTED]");
    expect(enqueue).toHaveBeenCalledWith(
      "webhooks",
      "shopify_order_create",
      { eventId: "event-1" },
      "high",
      "shopify-delivery-1",
    );
  });
  it("does not enqueue a duplicate Shopify delivery", async () => {
    store.mockResolvedValueOnce({ id: "event-1", inserted: false, status: "received" });
    const body = JSON.stringify({ id: 123 });
    const signature = createHmac("sha256", "shopify-secret").update(body).digest("base64");
    const { receiveShopifyWebhook } = await import("@/lib/shopify/webhooks");
    const result = await receiveShopifyWebhook(new Request("https://sync.example.com", { method: "POST", headers: { "x-shopify-hmac-sha256": signature, "x-shopify-webhook-id": "delivery-1", "x-shopify-topic": "orders/create" }, body }), "orders_create");
    expect(result.body.duplicate).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("rejects invalid Shopify signatures before persistence", async () => {
    const { receiveShopifyWebhook } = await import("@/lib/shopify/webhooks");
    const result = await receiveShopifyWebhook(
      new Request("https://sync.example.com", {
        method: "POST",
        headers: { "x-shopify-hmac-sha256": "bad" },
        body: "{}",
      }),
      "orders_create",
    );
    expect(result.status).toBe(401);
  });
  it("persists and queues a KiotViet stock event", async () => {
    store.mockResolvedValueOnce({
      id: "event-2",
      inserted: true,
      status: "received",
    });
    const body = JSON.stringify({
        Id: "kv-1",
        Attempt: 1,
        Notifications: [{ Action: "stock.update.501195938", Data: [] }],
      }),
      key = Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!, "base64"),
      signature = createHmac("sha256", key).update(body).digest("hex");
    const { receiveKiotVietWebhook } = await import("@/lib/kiotviet/webhooks");
    const result = await receiveKiotVietWebhook(
      new Request("https://sync.example.com", {
        method: "POST",
        headers: { "x-hub-signature": signature },
        body,
      }),
    );
    expect(result.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      "webhooks",
      "kiotviet_inventory_to_shopify",
      { eventId: "event-2" },
      "high",
      "kiotviet-kv-1",
    );
  });
  it("acknowledges but does not misroute an unsupported KiotViet event", async () => {
    store.mockResolvedValueOnce({ id: "event-unsupported", inserted: true, status: "received" });
    const body = JSON.stringify({ Id: "kv-unsupported", Notifications: [{ Action: "customer.update", Data: [{ Id: 1 }] }] });
    const signature = createHmac("sha256", Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!, "base64")).update(body).digest("hex");
    const { receiveKiotVietWebhook } = await import("@/lib/kiotviet/webhooks");
    const result = await receiveKiotVietWebhook(new Request("https://sync.example.com", { method: "POST", headers: { "x-hub-signature": signature }, body }));
    expect(result).toMatchObject({ status: 200, body: { success: true, unsupported: true } });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
