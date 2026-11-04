import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";
import {
  enqueueJob,
  getQueue,
  QUEUE_NAMES,
  type QueueName,
} from "@/lib/queue/queues";
import type { JobPriority, JobType, SyncJobPayload } from "@/lib/queue/jobs";
import { isRedisEnabled } from "@/lib/redis/client";
const schema = z.object({ action: z.enum(["retry", "cancel", "resolve"]) });
interface JobRow {
  type: JobType;
  payload: SyncJobPayload;
  priority: JobPriority;
  queue_job_id: string | null;
  status: string;
}
function queueFor(type: JobType): QueueName {
  if (type.includes("reconciliation")) return "reconciliation";
  if (type === "cleanup_old_data" || type === "webhook_recovery")
    return "maintenance";
  if (type.startsWith("shopify_") || type.startsWith("kiotviet_"))
    return "webhooks";
  return "sync";
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const { id } = await params,
      { action } = schema.parse(await request.json());
    const rows = await query<JobRow>(
      "SELECT type,payload,priority,queue_job_id,status FROM sync_jobs WHERE id=$1",
      [id],
    );
    const job = rows[0];
    if (!job)
      return Response.json(
        { success: false, error: "Job not found" },
        { status: 404 },
      );
    if (action === "retry") {
      if (job.type === "shopify_invoice_create") {
        // Permanent per-order audit identity. Retrying never resets invoice claims.
        if (!isRedisEnabled()) return Response.json({ success: false, error: "Redis worker is required for invoice retries" }, { status: 409 });
        const queue = getQueue("sync");
        const queueId = job.queue_job_id ?? `invoice-${id}`;
        const existing = await queue.getJob(queueId);
        const state = existing ? await existing.getState() : undefined;
        if (existing) {
          if (state !== "failed" && state !== "completed")
            return Response.json({ success: false, error: "Invoice job is already queued or processing" }, { status: 409 });
        }
        // At most one active invoice job per order (unique index invoice_job_active_order_idx).
        const claimed = await query("UPDATE sync_jobs SET queue_job_id=$2,status='pending',error=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('pending','processing') AND NOT EXISTS (SELECT 1 FROM sync_jobs other WHERE other.type='shopify_invoice_create' AND other.id<>sync_jobs.id AND other.payload->>'entityId'=sync_jobs.payload->>'entityId' AND other.status IN ('pending','processing')) RETURNING id", [id, queueId]);
        if (!claimed.length) return Response.json({ success: false, error: "Invoice retry already requested" }, { status: 409 });
        try {
        if (existing) await existing.retry(state as "failed" | "completed");
        else {
          await queue.add(job.type, { ...job.payload, auditJobId: id }, {
            jobId: queueId, attempts: 1, removeOnComplete: false, removeOnFail: false,
          });
        }
        } catch (error) {
          await query("UPDATE sync_jobs SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='pending'", [id, String(error)]);
          throw error;
        }
        return Response.json({ success: true, jobId: queueId });
      }
      const queued = await enqueueJob(
        queueFor(job.type),
        job.type,
        job.payload,
        job.priority,
      );
      await query(
        "UPDATE sync_jobs SET status='cancelled',updated_at=now() WHERE id=$1",
        [id],
      );
      return Response.json({ success: true, jobId: queued.id });
    }
    if (action === "cancel") {
      if (isRedisEnabled() && job.queue_job_id)
        for (const name of QUEUE_NAMES) {
          const queued = await getQueue(name).getJob(job.queue_job_id);
          if (queued) {
            await queued.remove().catch(() => undefined);
            break;
          }
        }
      await query(
        "UPDATE sync_jobs SET status='cancelled',completed_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
    } else
      await query(
        "UPDATE sync_jobs SET status='completed',completed_at=now(),error=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND status='manual_review'",
        [id],
      );
    return Response.json({ success: true });
  } catch (error) {
    return adminApiErrorResponse(error, "Action failed");
  }
}
