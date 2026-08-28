const sensitiveKey = /authorization|cookie|email|phone|address|password|secret|signature|token/i;

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeForLog(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : sanitizeForLog(item, depth + 1)]));
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}
