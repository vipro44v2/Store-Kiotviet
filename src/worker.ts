import { UnrecoverableError, Worker } from "bullmq";
import os from "node:os";
import { assertProductionEnv, getEnv } from "../lib/env";
import { getRedis, closeRedis } from "../lib/redis/client";
import { closeDatabase, query } from "../lib/db/client";
import { QUEUE_NAMES } from "../lib/queue/queues";
import { processSyncJob, isManualReview } from "../lib/queue/worker";
import { jobsRepository } from "../repositories/jobs";
import { retryDelay, type JobType } from "../lib/queue/jobs";
import { webhooksRepository } from "../repositories/webhooks";
if (getEnv().NODE_ENV === "production") assertProductionEnv();
const workerId = `${os.hostname()}:${process.pid}`;
const workers = QUEUE_NAMES.map(
  (name) =>
    new Worker(
      name,
      async (job) => {
        let auditId = job.data.auditJobId ? String(job.data.auditJobId) : "";
        if (!auditId) {
          const queueJobId=String(job.id);
          const existing=await query<{id:string}>("SELECT id FROM sync_jobs WHERE queue_job_id=$1",[queueJobId]);
          if(existing[0])auditId=existing[0].id;
          else{
            auditId=await jobsRepository.create(job.name as JobType,job.data,"low",getEnv().JOB_MAX_ATTEMPTS);
            try{await jobsRepository.attachQueueJob(auditId,queueJobId);}catch{
              const raced=await query<{id:string}>("SELECT id FROM sync_jobs WHERE queue_job_id=$1",[queueJobId]);
              if(!raced[0])throw new Error(`Could not attach audit record to queue job ${queueJobId}`);
              auditId=raced[0].id;
            }
          }
          await job.updateData({...job.data,auditJobId:auditId});
        }
        await jobsRepository.start(auditId, job.attemptsMade + 1);
        try {
          const result = await processSyncJob(job);
          await jobsRepository.complete(auditId);
          return result;
        } catch (error) {
          const e = error instanceof Error ? error : new Error(String(error)),
            manual = isManualReview(e);
          if (job.data.eventId)
            await webhooksRepository.markFailed(job.data.eventId, e.message);
          await jobsRepository.fail(auditId, e, manual);
          if (manual) throw new UnrecoverableError(e.message);
          throw e;
        }
      },
      {
        connection: getRedis(),
        concurrency: getEnv().WORKER_CONCURRENCY,
        settings: {
          backoffStrategy: (attemptsMade) => retryDelay(attemptsMade),
        },
      },
    ),
);
const heartbeat = setInterval(
  () =>
    void query(
      "INSERT INTO worker_heartbeats(worker_id,last_seen_at,status,metadata) VALUES($1,now(),'healthy',$2) ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=now(),status='healthy',metadata=EXCLUDED.metadata",
      [workerId, JSON.stringify({ pid: process.pid, hostname: os.hostname() })],
    ),
  15000,
);
heartbeat.unref();
async function shutdown() {
  clearInterval(heartbeat);
  await Promise.all(workers.map((w) => w.close()));
  await closeRedis();
  await closeDatabase();
}
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.stdout.write(
  `${JSON.stringify({ level: "info", message: "Worker started", workerId, queues: QUEUE_NAMES })}\n`,
);
