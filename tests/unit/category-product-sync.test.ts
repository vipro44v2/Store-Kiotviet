import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  assertOrigin: vi.fn(),
  getProducts: vi.fn(),
  enqueue: vi.fn(),
  log: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth/middleware", () => ({
  requireAdmin: mocks.requireAdmin,
  adminApiErrorResponse: (error: unknown, fallback: string) =>
    Response.json(
      { error: error instanceof Error ? error.message : fallback },
      { status: 400 },
    ),
}));
vi.mock("@/lib/security/csrf", () => ({ assertTrustedOrigin: mocks.assertOrigin }));
vi.mock("@/lib/kiotviet/products", () => ({
  getAllKiotVietProductsByCategory: mocks.getProducts,
}));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { POST } from "@/app/api/admin/products/category-sync/route";

describe("KiotViet category product sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue({ id: "job" });
    mocks.log.mockResolvedValue(undefined);
  });

  it("queues only unique KiotViet to Shopify jobs and reports counts", async () => {
    mocks.getProducts.mockResolvedValue([
      { id: 1, code: " A ", name: "A" },
      { id: 2, code: "B", name: "B" },
      { id: 3, code: " b ", name: "Duplicate B" },
      { id: 4, code: "", name: "Missing" },
      { id: 5, code: "C", name: "C" },
    ]);
    mocks.enqueue.mockResolvedValueOnce({ id: "a" }).mockRejectedValueOnce(new Error("queue down"));

    const response = await POST(
      new Request("https://store.example/api/admin/products/category-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryId: 42 }),
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      direction: "kiotviet_to_shopify",
      queued: 1,
      skipped: 3,
      failed: 1,
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "sync",
      "kiotviet_product_to_shopify",
      expect.objectContaining({ productId: 1, direction: "kiotviet_to_shopify" }),
      "normal",
    );
  });
});

