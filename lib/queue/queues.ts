import { Queue } from "bullmq";
import { getRedis, isRedisEnabled } from "@/lib/redis/client";
import type { JobPriority, JobType, SyncJobPayload } from "./jobs";
import { priorityNumber } from "./jobs";
import { getEnv } from "@/lib/env";
import { jobsRepository } from "@/repositories/jobs";

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
  const auditId = await jobsRepository.create(type, payload, priority, getEnv().JOB_MAX_ATTEMPTS);
  if (!isRedisEnabled()) {
    await jobsRepository.attachQueueJob(auditId, `local-${auditId}`);
    await jobsRepository.start(auditId, 1);
    try {
      const { processSyncJob } = await import("./worker");
      await processSyncJob({ name: type, data: { ...payload, auditJobId: auditId } } as never);
      await jobsRepository.complete(auditId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const { isManualReview } = await import("./worker");
      await jobsRepository.fail(auditId, failure, isManualReview(failure));
      throw failure;
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
  });
  const deduplicated = job.data.auditJobId !== auditId;
  if (deduplicated) await jobsRepository.complete(auditId);
  await jobsRepository.attachQueueJob(auditId, String(job.id));
  return Object.assign(job, { deduplicated });
}

export async function closeQueues(): Promise<void> { await Promise.all([...queues.values()].map((queue) => queue.close())); queues.clear(); }
