import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), getPage: vi.fn() }));
vi.mock("@/lib/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/middleware")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/admin/product-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/product-catalog")>();
  return { ...actual, getAdminProductCatalogPage: mocks.getPage };
});

import { GET } from "@/app/api/admin/products/route";

describe("admin products API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.getPage.mockResolvedValue({ products: [], page: 3, pageSize: 80, total: 2143, totalPages: 27 });
  });

  it("is protected by the final admin session", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthenticationError());
    const response = await GET(new Request("https://store.example/api/admin/products"));
    expect(response.status).toBe(401);
    expect(mocks.getPage).not.toHaveBeenCalled();
  });

  it("passes pagination, search, and category filters to the catalog service", async () => {
    const response = await GET(new Request("https://store.example/api/admin/products?page=3&pageSize=80&search=HAT&categoryId=123"));
    expect(response.status).toBe(200);
    expect(mocks.getPage).toHaveBeenCalledWith({ page: 3, pageSize: 80, search: "HAT", categoryId: 123 });
    await expect(response.json()).resolves.toMatchObject({ total: 2143, totalPages: 27 });
  });

  it("returns an error without issuing per-product fallback requests when KiotViet fails", async () => {
    mocks.getPage.mockRejectedValue(new Error("KiotViet unavailable"));
    const response = await GET(new Request("https://store.example/api/admin/products"));
    expect(response.status).toBe(502);
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
  });
});
