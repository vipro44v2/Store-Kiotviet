import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inventory: vi.fn(), sync: vi.fn(), query: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/kiotviet/inventory", () => ({ getKiotVietInventory: mocks.inventory }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: mocks.sync }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
import { reconcileInventoryPage } from "@/lib/sync/reconciliation";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inventory.mockResolvedValue({ data: [
    { id: 1, code: "1146", inventories: [{ branchId: 10, onHand: 9, reserved: 0 }] },
    { id: 2, code: "140", inventories: [{ branchId: 20, onHand: 8, reserved: 0 }] },
  ], pageSize: 2, total: 4 });
});
it("fails reconciliation on read-back errors while continuing other products and pages", async () => {
  mocks.sync.mockRejectedValueOnce(new Error("Inventory verification failed")).mockResolvedValueOnce(undefined);
  await expect(reconcileInventoryPage(0, "job-1")).rejects.toThrow("1146 (branch 10): Inventory verification failed");
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO sync_conflicts"), ["1146", expect.stringContaining("Inventory verification failed")]);
  expect(mocks.enqueue).toHaveBeenCalledWith("reconciliation", "inventory_reconciliation", { currentItem: 2 }, "low", "inventory-reconciliation-2");
});
it("completes when all inventory notifications are verified", async () => {
  mocks.sync.mockResolvedValue(undefined);
  await expect(reconcileInventoryPage()).resolves.toEqual({ processed: 2, next: 2, total: 4 });
  expect(mocks.query).not.toHaveBeenCalled();
});
