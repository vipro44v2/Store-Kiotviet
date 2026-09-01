import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  assertOrigin: vi.fn(),
  queueCatalog: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/middleware")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/security/csrf", () => ({ assertTrustedOrigin: mocks.assertOrigin }));
vi.mock("@/lib/queue/product-sync-batches", () => ({
  queueKiotVietCatalog: mocks.queueCatalog,
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { POST } from "@/app/api/admin/products/sync-all/route";

const request = () => new Request("https://store.example/api/admin/products/sync-all", { method: "POST" });

describe("sync all products from KiotViet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.queueCatalog.mockResolvedValue({ total: 5, queued: 2, skipped: 3, failed: 0 });
    mocks.log.mockResolvedValue(undefined);
  });

  it("is protected", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthenticationError());
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.queueCatalog).not.toHaveBeenCalled();
  });

  it("queues all fetched KiotViet IDs without reading mappings", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      direction: "kiotviet_to_shopify",
      queued: 2,
      skipped: 3,
      failed: 0,
    });
    expect(mocks.queueCatalog).toHaveBeenCalledWith();
  });
});
