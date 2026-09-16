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
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.clientQuery.mockResolvedValueOnce({ rows: [] }); // Per-SKU transaction lock.
  });

  it("rejects a normalized SKU owned by another KiotViet product", async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ id: "mapping-other", kiotviet_product_id: "999" }] });
    await expect(mappingsRepository.upsertExact(input)).rejects.toThrow(
      "already mapped to KiotViet product 999",
    );
    expect(mocks.clientQuery).toHaveBeenCalledTimes(2);
  });

  it("updates only the exact locked mapping row", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ id: "mapping-501", kiotviet_product_id: "501" }] })
      .mockResolvedValueOnce({ rows: [{ id: "mapping-501", ...input }] });
    await mappingsRepository.upsertExact(input);
    expect(mocks.clientQuery.mock.calls[2][0]).toContain("WHERE id=$1");
    expect(mocks.clientQuery.mock.calls[2][1][0]).toBe("mapping-501");
  });

  it("clears an old sync hash atomically with the pending identity update", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ id: "mapping-501", kiotviet_product_id: "501", last_sync_hash: "old" }] })
      .mockResolvedValueOnce({ rows: [{ id: "mapping-501", ...input, last_sync_hash: null }] });
    await mappingsRepository.upsertExact(input, { resetSyncHash: true });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(3);
    expect(mocks.clientQuery.mock.calls[2][0]).toContain("last_sync_hash=CASE WHEN $10::boolean THEN NULL ELSE last_sync_hash END");
    expect(mocks.clientQuery.mock.calls[2][0]).toContain("sync_status='mapped'");
    expect(mocks.clientQuery.mock.calls[2][1][9]).toBe(true);
  });

  it.each(["upsert", "upsertExact"] as const)("%s inserts a new owner without updating archived history", async (method) => {
    const history = { id: "old", kiotviet_product_id: "400", sync_status: "archived" };
    mocks.clientQuery.mockResolvedValueOnce({ rows: [history] })
      .mockResolvedValueOnce({ rows: [{ id: "new", ...input }] });
    await expect(mappingsRepository[method](input)).resolves.toMatchObject({ id: "new", kiotviet_product_id: "501" });
    expect(mocks.clientQuery.mock.calls[2][0]).toContain("INSERT INTO product_mappings");
    expect(history).toEqual({ id: "old", kiotviet_product_id: "400", sync_status: "archived" });
    expect(mocks.clientQuery.mock.calls[0]).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["SKU-1"],
    ]);
  });

  it("does not overwrite an active owner through the generic upsert", async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ kiotviet_product_id: "999", sync_status: "synced" }] });
    await expect(mappingsRepository.upsert(input)).rejects.toThrow("already mapped to KiotViet product 999");
  });
});
