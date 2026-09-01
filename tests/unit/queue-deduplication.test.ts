import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  create: vi.fn(),
  attach: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    close = vi.fn();
  },
}));
vi.mock("@/lib/redis/client", () => ({ getRedis: vi.fn(() => ({})), isRedisEnabled: vi.fn(() => true) }));
vi.mock("@/lib/env", () => ({ getEnv: vi.fn(() => ({ JOB_MAX_ATTEMPTS: 3 })) }));
vi.mock("@/repositories/jobs", () => ({
  jobsRepository: {
    create: mocks.create,
    attachQueueJob: mocks.attach,
    complete: mocks.complete,
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
