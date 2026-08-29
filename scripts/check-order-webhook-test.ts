import { query } from "../lib/db/client";

async function main() {
  const rows = await query(
    "SELECT w.webhook_id,w.status webhook_status,w.error webhook_error,j.status job_status,j.error job_error,j.attempts FROM webhook_events w LEFT JOIN sync_jobs j ON j.payload->>'eventId'=w.id::text WHERE w.webhook_id LIKE 'order-%-test-%' ORDER BY w.received_at DESC LIMIT 1",
  );
  console.log(JSON.stringify(rows[0] ?? null, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
