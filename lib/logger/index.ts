import { query } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { sanitizeForLog } from "@/lib/security/sanitize";

type Level = "debug" | "info" | "warn" | "error";
const weights: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
export async function log(
  level: Level,
  message: string,
  context: Record<string, unknown> = {},
) {
  const safeContext = sanitizeForLog(context) as Record<string, unknown>;
  if (weights[level] >= weights[getEnv().LOG_LEVEL])
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...safeContext })}\n`,
    );
  if (level !== "debug" && safeContext.action) {
    try {
      await query(
        "INSERT INTO sync_logs(job_id,level,provider,entity_type,entity_id,action,message,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          safeContext.jobId ?? null,
          level,
          safeContext.provider ?? null,
          safeContext.entityType ?? null,
          safeContext.entityId ?? null,
          safeContext.action,
          message,
          JSON.stringify(safeContext),
        ],
      );
    } catch {
      process.stderr.write(
        `${JSON.stringify({ level: "error", message: "Unable to persist log" })}\n`,
      );
    }
  }
}
