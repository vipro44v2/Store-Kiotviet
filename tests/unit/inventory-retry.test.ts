import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConflictError, MappingError, RetryableError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({ process: vi.fn(), create: vi.fn(), attach: vi.fn(), start: vi.fn(), fail: vi.fn(), complete: vi.fn(), redis: vi.fn(), add: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { add = mocks.add; close = vi.fn(); } }));
vi.mock("@/lib/redis/client", () => ({ getRedis: vi.fn(() => ({})), isRedisEnabled: mocks.redis }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ JOB_MAX_ATTEMPTS: 3 }) }));
vi.mock("@/repositories/jobs", () => ({ jobsRepository: { create: mocks.create, attachQueueJob: mocks.attach, start: mocks.start, fail: mocks.fail, complete: mocks.complete } }));
vi.mock("@/lib/queue/worker", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/queue/worker")>(), processSyncJob: mocks.process }));
import { enqueueJob } from "@/lib/queue/queues";
import { isManualReview } from "@/lib/queue/worker";

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); mocks.create.mockResolvedValue("audit-1"); mocks.redis.mockReturnValue(false); });
afterEach(() => vi.useRealTimers());

it("retries inventory without Redis using the existing backoff and completes only after success", async () => {
  mocks.process.mockRejectedValueOnce(new RetryableError("Readback mismatch")).mockResolvedValueOnce(undefined);
  const result = enqueueJob("sync", "kiotviet_inventory_to_shopify", {});
  await vi.advanceTimersByTimeAsync(59_999);
  expect(mocks.process).toHaveBeenCalledTimes(1);
  expect(mocks.complete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(mocks.start.mock.calls).toEqual([["audit-1", 1], ["audit-1", 2]]);
  expect(mocks.complete).toHaveBeenCalledOnce();
});

it("stops inventory retries at JOB_MAX_ATTEMPTS", async () => {
  mocks.process.mockRejectedValue(new RetryableError("Stale quantity"));
  const result = expect(enqueueJob("sync", "kiotviet_inventory_to_shopify", {})).rejects.toThrow("Stale quantity");
  await vi.runAllTimersAsync(); await result;
  expect(mocks.process).toHaveBeenCalledTimes(3);
  expect(mocks.complete).not.toHaveBeenCalled();
});

it.each([new MappingError("No mapping"), new ConflictError("Multiple mappings")])("does not retry mapping errors: %s", async error => {
  mocks.process.mockRejectedValue(error);
  await expect(enqueueJob("sync", "kiotviet_inventory_to_shopify", {})).rejects.toBe(error);
  expect(mocks.process).toHaveBeenCalledOnce();
  expect(mocks.fail).toHaveBeenCalledWith("audit-1", error, true);
  expect(isManualReview(error)).toBe(true);
  expect(isManualReview(new RetryableError("Readback mismatch"))).toBe(false);
});

it("preserves one-shot local behavior for unrelated jobs", async () => {
  mocks.process.mockRejectedValue(new RetryableError("Unrelated failure"));
  await expect(enqueueJob("sync", "shopify_order_create", {})).rejects.toThrow("Unrelated failure");
  expect(mocks.process).toHaveBeenCalledOnce();
});

it("keeps bounded BullMQ attempts and custom backoff", async () => {
  mocks.redis.mockReturnValue(true);
  mocks.add.mockResolvedValue({ id: "queue-1", data: { auditJobId: "audit-1" } });
  await enqueueJob("sync", "kiotviet_inventory_to_shopify", {});
  expect(mocks.add).toHaveBeenCalledWith("kiotviet_inventory_to_shopify", expect.any(Object), expect.objectContaining({ attempts: 3, backoff: { type: "custom" } }));
});
