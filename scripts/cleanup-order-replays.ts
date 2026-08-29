import { getQueue, closeQueues } from "../lib/queue/queues";
import { query, closeDatabase } from "../lib/db/client";
import { closeRedis } from "../lib/redis/client";

async function main() {
  const ids = ["kiotviet-order-replay-1011-v2", "kiotviet-order-replay-1009-v2"];
  for (const id of ids) await (await getQueue("webhooks").getJob(id))?.remove();
  await query(
    "UPDATE sync_jobs SET status='completed',error=NULL,completed_at=now(),updated_at=now() WHERE queue_job_id=ANY($1::text[])",
    [ids],
  );
}

main().finally(async () => {
  await closeQueues();
  await closeRedis();
  await closeDatabase();
});
