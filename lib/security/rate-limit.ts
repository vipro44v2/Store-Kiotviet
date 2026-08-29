import { getRedis, isRedisEnabled } from "@/lib/redis/client";

const localWindows = new Map<string, { count: number; expiresAt: number }>();

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!isRedisEnabled()) {
    const now = Date.now();
    const current = localWindows.get(key);
    const entry =
      !current || current.expiresAt <= now
        ? { count: 1, expiresAt: now + windowSeconds * 1_000 }
        : { ...current, count: current.count + 1 };
    localWindows.set(key, entry);
    return entry.count <= limit;
  }
  const redis = getRedis();
  const namespaced = `ratelimit:${key}`;
  const count = await redis.incr(namespaced);
  if (count === 1) await redis.expire(namespaced, windowSeconds);
  return count <= limit;
}
