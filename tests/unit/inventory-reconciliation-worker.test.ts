import { beforeEach, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { SyncJobPayload } from "@/lib/queue/jobs";
const mocks = vi.hoisted(() => ({ get: vi.fn(), processed: vi.fn(), admit: vi.fn(), page: vi.fn(), log: vi.fn() }));
vi.mock("@/repositories/webhooks", () => ({ webhooksRepository: { get: mocks.get, markProcessed: mocks.processed } }));
vi.mock("@/repositories/inventory-reconciliation", () => ({ admitInventoryReconciliation: mocks.admit }));
vi.mock("@/lib/sync/reconciliation", () => ({ reconcileInventoryPage: mocks.page, cleanupOldData: vi.fn() }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
import { processSyncJob } from "@/lib/queue/worker";
const job = (data: SyncJobPayload) => ({ name: "inventory_reconciliation", data }) as Job<SyncJobPayload>;
beforeEach(() => vi.resetAllMocks());

it("drains a legacy webhook reconciliation without scanning or acquiring a chain", async () => {
  mocks.get.mockResolvedValue({ event_type: "inventory_levels/update" });
  await processSyncJob(job({ eventId: "old-event" }));
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.page).not.toHaveBeenCalled();
  expect(mocks.processed).toHaveBeenCalledWith("old-event");
});

it("skips an overlapping scheduler root", async () => {
  mocks.admit.mockResolvedValue({ deduplicated: true });
  await processSyncJob(job({ auditJobId: "new-root" }));
  expect(mocks.page).not.toHaveBeenCalled();
});

it("passes the same chain to pagination", async () => {
  mocks.admit.mockResolvedValue({ deduplicated: false, payload: { reconciliationChainId: "chain" } });
  await processSyncJob(job({ currentItem: 100, auditJobId: "page", reconciliationChainId: "chain" }));
  expect(mocks.page).toHaveBeenCalledWith(100, "page", "chain");
});
