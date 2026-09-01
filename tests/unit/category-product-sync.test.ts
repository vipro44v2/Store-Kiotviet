import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  assertOrigin: vi.fn(),
  queueCatalog: vi.fn(),
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
vi.mock("@/lib/queue/product-sync-batches", () => ({ queueKiotVietCatalog: mocks.queueCatalog }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { POST } from "@/app/api/admin/products/category-sync/route";

describe("KiotViet category product sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.queueCatalog.mockResolvedValue({ total: 5, queued: 2, skipped: 2, failed: 1 });
    mocks.log.mockResolvedValue(undefined);
  });

  it("queues only unique KiotViet to Shopify jobs and reports counts", async () => {
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
      queued: 2,
      skipped: 2,
      failed: 1,
    });
    expect(mocks.queueCatalog).toHaveBeenCalledWith({ categoryId: 42 });
  });
});
