import { Queue } from "bullmq";
import { getRedis, isRedisEnabled } from "@/lib/redis/client";
import type { JobPriority, JobType, SyncJobPayload } from "./jobs";
import { priorityNumber, retryDelay } from "./jobs";
import { getEnv } from "@/lib/env";
import { jobsRepository } from "@/repositories/jobs";
import { admitInventoryReconciliation, isInventoryReconciliation } from "@/repositories/inventory-reconciliation";
import { log } from "@/lib/logger";

export const QUEUE_NAMES = ["sync", "webhooks", "reconciliation", "maintenance"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
const queues = new Map<QueueName, Queue<SyncJobPayload>>();

export function getQueue(name: QueueName): Queue<SyncJobPayload> {
  let queue = queues.get(name);
  if (!queue) { queue = new Queue<SyncJobPayload>(name, { connection: getRedis() }); queues.set(name, queue); }
  return queue;
}

export async function enqueueJob(
  name: QueueName,
  type: JobType,
  payload: SyncJobPayload,
  priority: JobPriority = "normal",
  jobId?: string,
  transientDeduplicationId?: string,
) {
  if (isInventoryReconciliation(type) && payload.eventId) {
    await log("info", "Webhook reconciliation enqueue ignored", {
      action: "inventory_webhook_ignored", reason: "scheduled_reconciliation_only", eventId: payload.eventId,
    });
    return { id: payload.eventId, deduplicated: true };
  }
  const admission = isInventoryReconciliation(type)
    ? await admitInventoryReconciliation(type, payload, priority, getEnv().JOB_MAX_ATTEMPTS)
    : undefined;
  if (admission?.deduplicated) return { id: admission.id, deduplicated: true };
  payload = admission?.payload ?? payload;
  const auditId = admission?.id ?? await jobsRepository.create(type, payload, priority, getEnv().JOB_MAX_ATTEMPTS);
  if (!isRedisEnabled()) {
    await jobsRepository.attachQueueJob(auditId, `local-${auditId}`);
    const inventoryJob = ["kiotviet_inventory_to_shopify", "inventory_reconciliation", "full_inventory_sync"].includes(type);
    const maxAttempts = inventoryJob ? getEnv().JOB_MAX_ATTEMPTS : 1;
    const { processSyncJob, isManualReview } = await import("./worker");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await jobsRepository.start(auditId, attempt);
      try {
        await processSyncJob({ name: type, data: { ...payload, auditJobId: auditId } } as never);
        await jobsRepository.complete(auditId);
        break;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const manual = isManualReview(failure);
        await jobsRepository.fail(auditId, failure, manual);
        if (manual || attempt === maxAttempts) throw failure;
        await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));
      }
    }
    return { id: `local-${auditId}`, deduplicated: false };
  }
  const job = await getQueue(name).add(type, { ...payload, auditJobId: auditId }, {
    attempts: getEnv().JOB_MAX_ATTEMPTS,
    backoff: { type: "custom" },
    priority: priorityNumber[priority],
    removeOnComplete: { age: 86_400 * 30, count: 10_000 },
    removeOnFail: false,
    jobId,
    deduplication: transientDeduplicationId
      ? { id: transientDeduplicationId }
      : undefined,
  }).catch(async (error: unknown) => {
    if (admission) await jobsRepository.fail(auditId, error instanceof Error ? error : new Error(String(error)), true);
    throw error;
  });
  const deduplicated = job.data.auditJobId !== auditId;
  if (deduplicated) await jobsRepository.complete(auditId);
  if (!deduplicated) await jobsRepository.attachQueueJob(auditId, String(job.id));
  return Object.assign(job, { deduplicated });
}

export async function closeQueues(): Promise<void> { await Promise.all([...queues.values()].map((queue) => queue.close())); queues.clear(); }
