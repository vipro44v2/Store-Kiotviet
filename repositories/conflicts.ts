import { query } from "@/lib/db/client";
export const conflictsRepository={list:(limit=200)=>query<Record<string,unknown>>("SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT $1",[limit]),resolve:(id:string,resolution:unknown)=>query("UPDATE sync_conflicts SET resolution_status='resolved',resolution=$2,resolved_at=now() WHERE id=$1",[id,JSON.stringify(resolution)])};
