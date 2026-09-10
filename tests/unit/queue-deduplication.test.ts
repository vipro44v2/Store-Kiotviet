import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  create: vi.fn(),
  attach: vi.fn(),
  complete: vi.fn(),
  admit: vi.fn(),
  fail: vi.fn(),
}));
vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    close = vi.fn();
  },
}));
vi.mock("@/lib/redis/client", () => ({ getRedis: vi.fn(() => ({})), isRedisEnabled: vi.fn(() => true) }));
vi.mock("@/lib/env", () => ({ getEnv: vi.fn(() => ({ JOB_MAX_ATTEMPTS: 3 })) }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/repositories/inventory-reconciliation", () => ({
  admitInventoryReconciliation: mocks.admit,
  isInventoryReconciliation: (type: string) => ["inventory_reconciliation", "full_inventory_sync"].includes(type),
}));
vi.mock("@/repositories/jobs", () => ({
  jobsRepository: {
    create: mocks.create,
    attachQueueJob: mocks.attach,
    complete: mocks.complete,
    fail: mocks.fail,
  },
}));

import { closeQueues, enqueueJob } from "@/lib/queue/queues";

describe("BullMQ transient product deduplication", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await closeQueues();
    mocks.create.mockResolvedValue("audit-new");
    mocks.add.mockResolvedValue({ id: "queue-existing", data: { auditJobId: "audit-first" } });
  });

  it("suppresses an overlapping job without using a permanent deterministic job ID", async () => {
    const result = await enqueueJob(
      "sync", "kiotviet_product_to_shopify",
      { productId: 501 }, "normal", undefined, "kiotviet-product-sync:family:500",
    );
    expect(mocks.add).toHaveBeenCalledWith(
      "kiotviet_product_to_shopify",
      expect.objectContaining({ auditJobId: "audit-new" }),
      expect.objectContaining({
        jobId: undefined,
        deduplication: { id: "kiotviet-product-sync:family:500" },
      }),
    );
    expect(result.deduplicated).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith("audit-new");
  });
});

it("does not enqueue reconciliation from webhook replay", async () => {
  vi.clearAllMocks();
  await enqueueJob("webhooks", "inventory_reconciliation", { eventId: "event" });
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.add).not.toHaveBeenCalled();
});

it("does not enqueue or create an audit for an overlapping root", async () => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue({ id: "existing", payload: {}, deduplicated: true });
  expect(await enqueueJob("reconciliation", "inventory_reconciliation", {})).toMatchObject({ id: "existing", deduplicated: true });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.add).not.toHaveBeenCalled();
});

it("releases an admission when queue publication fails", async () => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue({ id: "root", payload: { reconciliationChainId: "chain" }, deduplicated: false });
  const error = new Error("Redis unavailable");
  mocks.add.mockRejectedValueOnce(error);
  await expect(enqueueJob("reconciliation", "inventory_reconciliation", {})).rejects.toBe(error);
  expect(mocks.fail).toHaveBeenCalledWith("root", error, true);
});
