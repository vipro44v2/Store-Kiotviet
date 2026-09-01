import { describe, expect, it } from "vitest";
import { deletedProductReferences } from "@/lib/queue/worker";

const payload = (data: unknown[], extra: Record<string, unknown> = {}) => ({
  Id: "714d7659-f158-4da5-9591-d9c9578f9e8c",
  Attempt: 1,
  Notifications: [{ Data: data, Action: "product.delete.501195938" }],
  ...extra,
});

describe("deletedProductReferences", () => {
  it("accepts the real numeric Data payload", () => {
    expect(deletedProductReferences(payload([43043454]))).toEqual([{ id: 43043454 }]);
  });
  it("accepts numeric strings, object IDs, RemoveId, and codes", () => {
    expect(deletedProductReferences(payload([
      "43043454", { ProductId: 43043455 }, { id: "43043456" },
      { RemoveId: [43043457, "bad"], productCode: " nu010 " },
      { sku: "NU010" }, null, false,
    ], { removeId: "43043458" }))).toEqual([
      { id: 43043458 }, { id: 43043454 }, { id: 43043455 },
      { id: 43043456 }, { id: 43043457 }, { code: "nu010" },
    ]);
  });
  it("throws only when a mixed malformed payload has no usable reference", () => {
    expect(() => deletedProductReferences(payload([null, false, "x", {}, { id: -1 }]))).toThrow(
      "contains no product ID or code",
    );
  });
});
