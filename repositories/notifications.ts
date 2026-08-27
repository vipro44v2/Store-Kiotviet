import { query } from "@/lib/db/client";
export const notificationsRepository={list:(limit=200)=>query<Record<string,unknown>>("SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1",[limit]),markRead:(id:string)=>query("UPDATE notifications SET read=true WHERE id=$1",[id])};
