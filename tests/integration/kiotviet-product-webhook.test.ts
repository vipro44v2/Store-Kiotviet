import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.fn();
const enqueue = vi.fn();
vi.mock("@/repositories/webhooks", () => ({ webhooksRepository: { store } }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: enqueue }));

beforeAll(() => {
  process.env.KIOTVIET_WEBHOOK_SECRET = Buffer.from("kiotviet-product-secret").toString("base64");
});
beforeEach(() => { store.mockReset(); enqueue.mockReset(); });

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

  it("queues single and bulk price changes for Shopify synchronization", async () => {
    store.mockResolvedValueOnce({ id: "event-pricebook-1", inserted: true, status: "received" });
    const body = JSON.stringify({
      Id: "kv-pricebook-1",
      Attempt: 1,
      Notifications: [{
        Action: "pricebookdetail.update",
        Data: [
          { PriceBookId: 0, ProductId: 43043436, Price: 125000 },
          { PriceBookId: 0, ProductId: 43043437, Price: 135000 },
        ],
      }],
    });
    const signature = createHmac("sha256", Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!, "base64")).update(body).digest("hex");
    const { receiveKiotVietWebhook } = await import("@/lib/kiotviet/webhooks");
    const result = await receiveKiotVietWebhook(new Request("https://sync.example.com/api/kiotviet/webhooks", { method: "POST", headers: { "x-hub-signature": signature }, body }));
    expect(result.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith("webhooks", "kiotviet_product_to_shopify", { eventId: "event-pricebook-1" }, "high", "kiotviet-kv-pricebook-1");
  });

  it("queues deleted variants for Shopify synchronization", async () => {
    store.mockResolvedValueOnce({ id: "event-product-delete", inserted: true, status: "received" });
    const body = JSON.stringify({ Id: "kv-product-delete", Attempt: 1, RemoveId: [43095701], Notifications: [] });
    const signature = createHmac("sha256", Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!, "base64")).update(body).digest("hex");
    const { receiveKiotVietWebhook } = await import("@/lib/kiotviet/webhooks");
    const result = await receiveKiotVietWebhook(new Request("https://sync.example.com/api/kiotviet/webhooks", { method: "POST", headers: { "x-hub-signature": signature }, body }));
    expect(result.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith("webhooks", "kiotviet_product_to_shopify", { eventId: "event-product-delete" }, "high", "kiotviet-kv-product-delete");
  });

  it("queues KiotViet order updates for Shopify cancellation", async () => {
    store.mockResolvedValueOnce({ id: "event-order-update", inserted: true, status: "received" });
    const body = JSON.stringify({ Id: "kv-order-update", Attempt: 1, Notifications: [{ Action: "order.update.501195938", Data: [{ Id: 24102572, Status: 4, StatusValue: "Đã hủy" }] }] });
    const signature = createHmac("sha256", Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!, "base64")).update(body).digest("hex");
    const { receiveKiotVietWebhook } = await import("@/lib/kiotviet/webhooks");
    const result = await receiveKiotVietWebhook(new Request("https://sync.example.com/api/kiotviet/webhooks", { method: "POST", headers: { "x-hub-signature": signature }, body }));
    expect(result.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith("webhooks", "kiotviet_order_to_shopify", { eventId: "event-order-update" }, "high", "kiotviet-kv-order-update");
  });

  it("queues category updates for Shopify collection synchronization",async()=>{
    store.mockResolvedValueOnce({id:"event-category",inserted:true,status:"received"});
    const body=JSON.stringify({Id:"kv-category",Attempt:1,Notifications:[{Action:"category.update",Data:[{CategoryId:42}]}]});
    const signature=createHmac("sha256",Buffer.from(process.env.KIOTVIET_WEBHOOK_SECRET!,"base64")).update(body).digest("hex");
    const {receiveKiotVietWebhook}=await import("@/lib/kiotviet/webhooks");
    await receiveKiotVietWebhook(new Request("https://sync.example.com",{method:"POST",headers:{"x-hub-signature":signature},body}));
    expect(enqueue).toHaveBeenCalledWith("webhooks","kiotviet_category_to_shopify",{eventId:"event-category"},"high","kiotviet-kv-category");
  });
});
