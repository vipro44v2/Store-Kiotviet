import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  transaction: (callback: (client: { query: typeof mocks.query }) => Promise<unknown>) => callback({ query: mocks.query }),
}));
import { admitInventoryReconciliation } from "@/repositories/inventory-reconciliation";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

it("atomically admits a root with a persistent chain ID", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "root" }] });
  const result = await admitInventoryReconciliation("inventory_reconciliation", {}, "low", 3);
  expect(result).toMatchObject({ id: "root", deduplicated: false, payload: { reconciliationChainId: expect.any(String) } });
  expect(mocks.query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
  expect(mocks.query.mock.calls[2][0]).toContain("INSERT INTO sync_jobs");
});

it("suppresses another full scan before creating an audit row", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "page", chain_id: "chain-1" }] });
  expect(await admitInventoryReconciliation("full_inventory_sync", {}, "low", 3)).toMatchObject({ id: "page", deduplicated: true });
  expect(mocks.query).toHaveBeenCalledTimes(2);
});

it("admits a child of the active chain despite pending/processing parent rows", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "root", chain_id: "chain-1" }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "page" }] });
  expect(await admitInventoryReconciliation("inventory_reconciliation", { currentItem: 100, reconciliationChainId: "chain-1" }, "low", 3)).toMatchObject({ id: "page", deduplicated: false });
});

it("does not create another page audit when its parent retries", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "root", chain_id: "chain-1" }] }).mockResolvedValueOnce({ rows: [{ id: "page" }] });
  expect(await admitInventoryReconciliation("inventory_reconciliation", { currentItem: 100, reconciliationChainId: "chain-1" }, "low", 3)).toMatchObject({ id: "page", deduplicated: true });
  expect(mocks.query).toHaveBeenCalledTimes(3);
});

it("allows a worker retry of the same chain", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "page", chain_id: "chain-1" }] });
  expect(await admitInventoryReconciliation("inventory_reconciliation", { reconciliationChainId: "chain-1" }, "low", 3, "root")).toMatchObject({ id: "root", deduplicated: false });
  expect(mocks.query.mock.calls[2][0]).toContain("UPDATE sync_jobs SET payload");
});

it("adopts legacy pagination jobs as one chain", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "old-page", chain_id: "legacy-inventory" }] });
  expect(await admitInventoryReconciliation("inventory_reconciliation", { currentItem: 200 }, "low", 3, "old-page-2")).toMatchObject({ deduplicated: false, payload: { reconciliationChainId: "legacy-inventory" } });
});

it("excludes old webhook jobs and terminal failures but includes pending pages and delayed retries", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "root", chain_id: "root" }] });
  await admitInventoryReconciliation("inventory_reconciliation", {}, "low", 3, "root");
  const sql = mocks.query.mock.calls[1][0] as string;
  expect(sql).toContain("NOT (payload ? 'eventId')");
  expect(sql).toContain("status IN ('pending','processing')");
  expect(sql).toContain("status='failed' AND attempts < max_attempts");
});
