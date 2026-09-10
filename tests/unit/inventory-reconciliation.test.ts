import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inventory: vi.fn(), sync: vi.fn(), query: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/kiotviet/inventory", () => ({ getKiotVietInventory: mocks.inventory }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: mocks.sync }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/queue/queues", () => ({ enqueueJob: mocks.enqueue }));
import { reconcileInventoryPage } from "@/lib/sync/reconciliation";
import { ConflictError, MappingError, RetryableError } from "@/lib/errors";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inventory.mockResolvedValue({ data: [
    { id: 1, code: "1146", inventories: [{ branchId: 10, onHand: 9, reserved: 0 }] },
    { id: 2, code: "140", inventories: [{ branchId: 20, onHand: 8, reserved: 0 }] },
  ], pageSize: 2, total: 4 });
});
it("fails reconciliation on read-back errors while continuing other products and pages", async () => {
  mocks.sync.mockRejectedValueOnce(new Error("Inventory verification failed")).mockResolvedValueOnce(undefined);
  await expect(reconcileInventoryPage(0, "job-1", "chain-1")).rejects.toThrow("1146 (branch 10): Inventory verification failed");
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO sync_conflicts"), ["1146", expect.stringContaining("Inventory verification failed")]);
  expect(mocks.enqueue).toHaveBeenCalledWith("reconciliation", "inventory_reconciliation", { currentItem: 2, reconciliationChainId: "chain-1" }, "low", "inventory-reconciliation-chain-1-2");
});

it("uses distinct page IDs for successive scans and stable IDs for retries", async () => {
  await reconcileInventoryPage(0, "job-1", "chain-1");
  await reconcileInventoryPage(0, "job-1", "chain-1");
  await reconcileInventoryPage(0, "job-2", "chain-2");
  expect(mocks.enqueue.mock.calls.map(call => call[4])).toEqual([
    "inventory-reconciliation-chain-1-2", "inventory-reconciliation-chain-1-2", "inventory-reconciliation-chain-2-2",
  ]);
});

it("finishes the last page without enqueueing", async () => {
  await reconcileInventoryPage(2, "job-1", "chain-1");
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("rejects non-progressing pagination", async () => {
  mocks.inventory.mockResolvedValue({ data: [], pageSize: 0, total: 4 });
  await expect(reconcileInventoryPage()).rejects.toBeInstanceOf(RetryableError);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("completes when all inventory notifications are verified", async () => {
  mocks.sync.mockResolvedValue(undefined);
  await expect(reconcileInventoryPage()).resolves.toEqual({ processed: 2, next: 2, total: 4 });
  expect(mocks.query).not.toHaveBeenCalled();
});

it("preserves manual review for mapping-only failures", async () => {
  mocks.sync.mockRejectedValue(new ConflictError("Multiple enabled mappings"));
  await expect(reconcileInventoryPage()).rejects.toBeInstanceOf(MappingError);
});

it("retries a page with transient failures even when another SKU needs manual mapping", async () => {
  mocks.sync.mockRejectedValueOnce(new MappingError("No SKU mapping"))
    .mockRejectedValueOnce(new RetryableError("Readback mismatch"));
  await expect(reconcileInventoryPage()).rejects.toBeInstanceOf(RetryableError);
});
