import IORedis from "ioredis";
import { getEnv } from "@/lib/env";

const globalRedis = globalThis as typeof globalThis & { __shopifyKiotVietRedis?: IORedis };

export function isRedisEnabled(): boolean {
  return Boolean(getEnv().REDIS_URL);
}

export function getRedis(): IORedis {
  if (globalRedis.__shopifyKiotVietRedis) return globalRedis.__shopifyKiotVietRedis;
  const url = getEnv().REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not configured");
  globalRedis.__shopifyKiotVietRedis = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  });
  return globalRedis.__shopifyKiotVietRedis;
}

export async function ensureRedisConnected(): Promise<IORedis> {
  const redis = getRedis();
  if (redis.status === "wait") await redis.connect();
  return redis;
}

export async function closeRedis(): Promise<void> {
  const redis = globalRedis.__shopifyKiotVietRedis;
  if (redis) { if (redis.status !== "end") await redis.quit(); delete globalRedis.__shopifyKiotVietRedis; }
}
