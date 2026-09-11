import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ categories: vi.fn(), query: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/kiotviet/products", () => ({ getAllKiotVietCategories: mocks.categories }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/auth/middleware", () => ({ requireAdmin: mocks.auth, adminApiErrorResponse: (e: Error) => Response.json({ error: e.message }, { status: 400 }) }));
vi.mock("@/lib/security/csrf", () => ({ assertTrustedOrigin: vi.fn() }));
import { PUT } from "@/app/api/admin/settings/[key]/route";
const save = (categoryIds: unknown) => PUT(new Request("http://localhost/api/admin/settings/draft_product_categories", {
  method: "PUT", body: JSON.stringify({ categoryIds }),
}), { params: Promise.resolve({ key: "draft_product_categories" }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.categories.mockResolvedValue([{ id: 10, name: "Testing" }, { categoryId: 20, categoryName: "Samples" }]);
});
it("validates against KiotViet and persists unique IDs", async () => {
  expect((await save([20, 10, 10])).status).toBe(200);
  expect(mocks.query.mock.calls[0][1]).toEqual(["draft_product_categories", '{"categoryIds":[10,20]}']);
});
it("allows clearing the list without KiotViet availability", async () => {
  expect((await save([])).status).toBe(200);
  expect(mocks.categories).not.toHaveBeenCalled();
});
it.each([[999], [-1], [1.5], ["10"], [null]])("rejects invalid IDs %j", async (id) => {
  expect((await save([id])).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("does not persist when category verification fails", async () => {
  mocks.categories.mockRejectedValueOnce(new Error("KiotViet unavailable"));
  expect((await save([10])).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
});
