import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), log: vi.fn() }));
vi.mock("@/repositories/settings", () => ({ settingsRepository: { get: mocks.get } }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
import { resolveProductStatus } from "@/lib/sync/product-status";
const product = { id: 1, code: "TEST", name: "Product", categoryId: 10, categoryName: "Testing" };
it("logs the configured category and source product", async () => {
  mocks.get.mockResolvedValue({ categoryIds: [10] });
  expect(await resolveProductStatus([product])).toBe("DRAFT");
  expect(mocks.log).toHaveBeenLastCalledWith("info", expect.any(String), {
    action: "shopify_product_status_resolved", kiotVietProductId: 1,
    categoryId: 10, categoryName: "Testing", resolvedStatus: "DRAFT", reason: "configured_draft_category",
  });
});
it("preserves the normal unsaleable status after leaving a draft category", async () => {
  mocks.get.mockResolvedValue({ categoryIds: [10] });
  expect(await resolveProductStatus([{ ...product, categoryId: 20, allowsSale: false }])).toBe("DRAFT");
  expect(mocks.log.mock.calls.at(-1)?.[2].reason).toBe("normal_product_status");
});
it("uses normal status for missing categories and an empty configuration", async () => {
  mocks.get.mockResolvedValue({ categoryIds: [] });
  expect(await resolveProductStatus([product])).toBe("ACTIVE");
  mocks.get.mockResolvedValue({ categoryIds: [10] });
  expect(await resolveProductStatus([{ ...product, categoryId: undefined }])).toBe("ACTIVE");
});

it("safely reads malformed and legacy stored settings during sync", async () => {
  mocks.get.mockResolvedValue({ categoryIds: "10" });
  expect(await resolveProductStatus([product])).toBe("ACTIVE");
  mocks.get.mockResolvedValue({ categoryIds: [10, 10, -1, "20", null] });
  expect(await resolveProductStatus([product])).toBe("DRAFT");
});
