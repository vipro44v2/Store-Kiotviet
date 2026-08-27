import { query } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

type Level = "debug" | "info" | "warn" | "error";
const weights: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export async function log(level: Level, message: string, context: Record<string, unknown> = {}) {
  if (weights[level] >= weights[getEnv().LOG_LEVEL]) process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context })}\n`);
  if (level !== "debug" && context.action) {
    try { await query("INSERT INTO sync_logs(job_id,level,provider,entity_type,entity_id,action,message,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [context.jobId ?? null,level,context.provider ?? null,context.entityType ?? null,context.entityId ?? null,context.action,message,JSON.stringify(context)]); }
    catch (error) { process.stderr.write(`${JSON.stringify({ level: "error", message: "Unable to persist log", error: error instanceof Error ? error.message : String(error) })}\n`); }
  }
}
