import { query } from "../lib/db/client";

async function main() {
  const rows = await query(
    "SELECT webhook_id,event_type,status,payload,received_at,error FROM webhook_events WHERE provider='kiotviet' ORDER BY received_at DESC LIMIT 20",
  );
  console.log(JSON.stringify(rows, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
