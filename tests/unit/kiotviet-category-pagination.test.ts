import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietFetch: fetchMock }));

import {
  getAllKiotVietProducts,
  getAllKiotVietProductsByCategory,
  getKiotVietVariantFamily,
} from "@/lib/kiotviet/products";

describe("KiotViet category pagination", () => {
  beforeEach(() => fetchMock.mockReset());

  it("fetches every category page", async () => {
    fetchMock
      .mockResolvedValueOnce({ total: 101, pageSize: 100, data: [{ id: 1, code: "A", name: "A" }] })
      .mockResolvedValueOnce({ total: 101, pageSize: 100, data: [{ id: 101, code: "Z", name: "Z" }] });
    await expect(getAllKiotVietProductsByCategory(42)).resolves.toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).toContain("categoryId=42");
    expect(fetchMock.mock.calls[0][0]).toContain("currentItem=0");
    expect(fetchMock.mock.calls[1][0]).toContain("currentItem=100");
  });

  it("fetches every product page without a category filter", async () => {
    fetchMock
      .mockResolvedValueOnce({ total: 101, pageSize: 100, data: [{ id: 1, code: "A", name: "A" }] })
      .mockResolvedValueOnce({ total: 101, pageSize: 100, data: [{ id: 101, code: "Z", name: "Z" }] });
    await expect(getAllKiotVietProducts()).resolves.toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).not.toContain("categoryId");
    expect(fetchMock.mock.calls[1][0]).toContain("currentItem=100");
  });

  it("loads a variant family with the supported masterProductId filter", async () => {
    fetchMock.mockResolvedValue({
      total: 2,
      pageSize: 100,
      data: [
        { id: 10, code: "MASTER", name: "Master", hasVariants: true },
        { id: 11, code: "BLUE", name: "Blue", masterProductId: 10 },
      ],
    });
    await expect(
      getKiotVietVariantFamily({ id: 11, code: "BLUE", name: "Blue", masterProductId: 10 }),
    ).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("masterProductId=10");
  });
});
