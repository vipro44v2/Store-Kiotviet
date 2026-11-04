import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getPool: () => ({ connect: async () => m }) }));
import { withInventoryLock } from "@/lib/db/inventory-lock";
beforeEach(() => { vi.resetAllMocks(); m.query.mockResolvedValue({ rows: [{ locked: true }] }); });
it("serializes stock work without opening a transaction", async () => {
  await withInventoryLock("stock", async () => 42);
  expect(m.query.mock.calls.map(c => c[0]).join(" ")).not.toContain("BEGIN");
  expect(m.query).toHaveBeenLastCalledWith(expect.stringContaining("pg_advisory_unlock"), ["stock"]);
});
it("rejects a concurrent writer before remote calls", async () => {
  m.query.mockResolvedValue({ rows: [{ locked: false }] });
  const work = vi.fn();
  await expect(withInventoryLock("stock", work)).rejects.toThrow("already running");
  expect(work).not.toHaveBeenCalled();
});
it("releases the lock after remote failure", async () => {
  await expect(withInventoryLock("stock", async () => { throw new Error("remote"); })).rejects.toThrow("remote");
  expect(m.query).toHaveBeenLastCalledWith(expect.stringContaining("pg_advisory_unlock"), ["stock"]);
  expect(m.release).toHaveBeenCalledWith(false);
});
