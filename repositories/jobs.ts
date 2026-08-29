import { query } from "@/lib/db/client";
import type { JobPriority, JobType, SyncJobPayload } from "@/lib/queue/jobs";

interface IdRow {
  id: string;
}
export const jobsRepository = {
  async create(
    type: JobType,
    payload: SyncJobPayload,
    priority: JobPriority,
    maxAttempts: number,
  ) {
    const [row] = await query<IdRow>(
      "INSERT INTO sync_jobs(type,payload,priority,max_attempts) VALUES($1,$2,$3,$4) RETURNING id",
      [type, JSON.stringify(payload), priority, maxAttempts],
    );
    return row.id;
  },
  async attachQueueJob(id: string, queueJobId: string) {
    await query(
      "UPDATE sync_jobs SET queue_job_id=$2,updated_at=now() WHERE id=$1",
      [id, queueJobId],
    );
  },
  async start(id: string, attempts: number) {
    await query(
      "UPDATE sync_jobs SET status='processing',attempts=$2,started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1",
      [id, attempts],
    );
  },
  async complete(id: string) {
    await query(
      "UPDATE sync_jobs SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
  },
  async fail(id: string, error: Error, manualReview: boolean) {
    await query(
      "UPDATE sync_jobs SET status=$2,error_code=$3,error=$4,completed_at=CASE WHEN $2='manual_review' THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1",
      [
        id,
        manualReview ? "manual_review" : "failed",
        error.name,
        error.message,
      ],
    );
  },
  async list(limit = 100) {
    return query<Record<string, unknown>>(
      "SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
  },
  async counts() {
    return query<{ status: string; count: string }>(
      "SELECT status,count(*)::text count FROM sync_jobs GROUP BY status",
    );
  },
};
