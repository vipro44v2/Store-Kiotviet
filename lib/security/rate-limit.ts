import { getRedis } from "@/lib/redis/client";
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const redis = getRedis(); const namespaced = `ratelimit:${key}`; const count = await redis.incr(namespaced);
  if (count === 1) await redis.expire(namespaced, windowSeconds);
  return count <= limit;
}
