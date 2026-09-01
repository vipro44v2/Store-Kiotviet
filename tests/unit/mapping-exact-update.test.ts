import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clientQuery: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
  transaction: (callback: (client: { query: typeof mocks.clientQuery }) => unknown) =>
    callback({ query: mocks.clientQuery }),
}));

import { mappingsRepository } from "@/repositories/mappings";

const input = {
  sku: "SKU-1",
  normalized_sku: "SKU-1",
  shopify_product_id: "product-new",
  shopify_variant_id: "variant-new",
  shopify_inventory_item_id: "inventory-new",
  kiotviet_product_id: "501",
  kiotviet_code: "SKU-1",
  sync_direction: "kiotviet_to_shopify",
  sync_status: "mapped",
};

describe("exact product mapping updates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a normalized SKU owned by another KiotViet product", async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ id: "mapping-other", kiotviet_product_id: "999" }] });
    await expect(mappingsRepository.upsertExact(input)).rejects.toThrow(
      "already mapped to KiotViet product 999",
    );
    expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
  });

  it("updates only the exact locked mapping row", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ id: "mapping-501", kiotviet_product_id: "501" }] })
      .mockResolvedValueOnce({ rows: [{ id: "mapping-501", ...input }] });
    await mappingsRepository.upsertExact(input);
    expect(mocks.clientQuery.mock.calls[1][0]).toContain("WHERE id=$1");
    expect(mocks.clientQuery.mock.calls[1][1][0]).toBe("mapping-501");
  });
});
