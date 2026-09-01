import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@/lib/errors";
import { resetEnvForTests } from "@/lib/env";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  query: vi.fn(),
  enqueue: vi.fn(),
  log: vi.fn(),
  ensureMapping: vi.fn(),
}));

vi.mock("@/lib/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/middleware")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/sync/ensure-kiotviet-product-mapping", () => ({
  ensureKiotVietProductMapping: mocks.ensureMapping,
}));

import { POST } from "@/app/api/admin/products/sync/route";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";

function request(mappingIds: string[]) {
  return new Request("http://localhost:3000/api/admin/products/sync", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ mappingIds }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "http://localhost:3000";
  resetEnvForTests();
  mocks.requireAdmin.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue({ id: "queued" });
  mocks.log.mockResolvedValue(undefined);
  mocks.ensureMapping.mockImplementation(async (productId: string) => ({
    status: "mapped",
    productId,
    sku: `SKU-${productId}`,
    mapping: {},
  }));
});

describe("manual KiotViet to Shopify product sync", () => {
  it("rejects an unauthenticated request", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthenticationError());
    const response = await POST(request([first]));
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("queues one mapped KiotViet product for Shopify sync", async () => {
    mocks.query.mockResolvedValue([{ id: first, kiotviet_product_id: "501" }]);
    const response = await POST(request([first]));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ queued: 1, missingMappings: 0 });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "sync",
      "kiotviet_product_to_shopify",
      { productId: "501", manual: true, direction: "kiotviet_to_shopify" },
      "normal",
    );
  });

  it("queues bulk products and deduplicates KiotViet product IDs", async () => {
    mocks.query.mockResolvedValue([
      { id: first, kiotviet_product_id: "501" },
      { id: second, kiotviet_product_id: "501" },
      { id: third, kiotviet_product_id: "502" },
    ]);
    const response = await POST(request([first, second, third]));
    await expect(response.json()).resolves.toMatchObject({ queued: 2, missingMappings: 0 });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.ensureMapping).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls.map((call) => call[2].productId).sort()).toEqual(["501", "502"]);
  });

  it("skips zero and duplicate exact Shopify matches before queueing", async () => {
    mocks.query.mockResolvedValue([
      { id: first, kiotviet_product_id: "501" },
      { id: second, kiotviet_product_id: "502" },
    ]);
    mocks.ensureMapping
      .mockResolvedValueOnce({ status: "missing_shopify", productId: "501", sku: "ONE", matches: 0 })
      .mockResolvedValueOnce({ status: "duplicate_shopify", productId: "502", sku: "TWO", matches: 2 });
    const response = await POST(request([first, second]));
    await expect(response.json()).resolves.toMatchObject({
      queued: 0,
      missingShopify: 1,
      duplicateShopify: 1,
      skipped: 2,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("skips missing mappings without guessing", async () => {
    mocks.query.mockResolvedValue([
      { id: first, kiotviet_product_id: null },
      { id: second, kiotviet_product_id: "502" },
    ]);
    const response = await POST(request([first, second, third]));
    await expect(response.json()).resolves.toMatchObject({
      queued: 1,
      missingMappings: 2,
      missingMappingIds: [first, third],
    });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("introduces no reverse Shopify to KiotViet manual path", async () => {
    mocks.query.mockResolvedValue([{ id: first, kiotviet_product_id: "501" }]);
    await POST(request([first]));
    for (const call of mocks.enqueue.mock.calls) {
      expect(call[1]).toBe("kiotviet_product_to_shopify");
      expect(call[1]).not.toBe("shopify_product_to_kiotviet");
      expect(call[2]).toMatchObject({ direction: "kiotviet_to_shopify" });
    }
  });
});
