import { query } from "@/lib/db/client";
export const logsRepository={list:(limit=200)=>query<Record<string,unknown>>("SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT $1",[limit])};
