import { describe, expect, it, vi } from "vitest";

const fetchCategory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietFetch: fetchCategory }));

import { getKiotVietCategory } from "@/lib/kiotviet/products";

describe("KiotViet category client", () => {
  it("unwraps the data response from the category endpoint", async () => {
    fetchCategory.mockResolvedValueOnce({
      data: { id: 42, categoryName: "Shoes" },
    });
    await expect(getKiotVietCategory(42)).resolves.toEqual({
      id: 42,
      categoryName: "Shoes",
    });
    expect(fetchCategory).toHaveBeenCalledWith("/categories/42");
  });
});
