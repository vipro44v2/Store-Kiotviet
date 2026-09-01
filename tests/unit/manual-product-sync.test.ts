import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@/lib/errors";
import { resetEnvForTests } from "@/lib/env";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), enqueue: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/middleware")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { POST } from "@/app/api/admin/products/sync/route";

function request(productIds: number[]) {
  return new Request("http://localhost:3000/api/admin/products/sync", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ productIds }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "http://localhost:3000";
  resetEnvForTests();
  mocks.requireAdmin.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue({ id: "queued" });
  mocks.log.mockResolvedValue(undefined);
});
describe("manual KiotViet to Shopify product sync", () => {
  it("rejects an unauthenticated request", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthenticationError());
    const response = await POST(request([501]));
    expect(response.status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("queues a KiotViet product ID without requiring a mapping", async () => {
    const response = await POST(request([501]));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ queued: 1, skipped: 0 });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "sync", "kiotviet_product_to_shopify",
      { productId: 501, manual: true, direction: "kiotviet_to_shopify" }, "normal",
    );
  });

  it("deduplicates variant-family representative IDs", async () => {
    const response = await POST(request([501, 501, 502]));
    await expect(response.json()).resolves.toMatchObject({ queued: 2 });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls.map((call) => call[2].productId).sort()).toEqual([501, 502]);
  });

  it("introduces no reverse Shopify to KiotViet path", async () => {
    await POST(request([501]));
    for (const call of mocks.enqueue.mock.calls) {
      expect(call[1]).toBe("kiotviet_product_to_shopify");
      expect(call[2]).toMatchObject({ direction: "kiotviet_to_shopify" });
    }
  });
});
