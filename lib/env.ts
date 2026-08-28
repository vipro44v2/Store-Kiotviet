import { z } from "zod";

const optionalUrl = z.string().url().optional().or(z.literal(""));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_APP_URL: optionalUrl,
  APP_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: optionalUrl,
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: optionalUrl,
  SHOPIFY_SHOP: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i).default(""),
  SHOPIFY_CLIENT_ID: z.string().default(""),
  SHOPIFY_CLIENT_SECRET: z.string().default(""),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/).default("2026-07"),
  KIOTVIET_CLIENT_ID: z.string().default(""),
  KIOTVIET_CLIENT_SECRET: z.string().default(""),
  KIOTVIET_RETAILER: z.string().default(""),
  KIOTVIET_WEBHOOK_SECRET: z.string().default(""),
  SESSION_SECRET: z.string().default(""),
  ADMIN_USERNAME: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppEnv = z.infer<typeof schema>;
let cached: AppEnv | undefined;

export function getEnv(): AppEnv {
  cached ??= schema.parse(process.env);
  return cached;
}

export function assertProductionEnv(): AppEnv {
  const env = getEnv();
  const required: Array<keyof AppEnv> = [
    "DATABASE_URL", "REDIS_URL", "SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET", "KIOTVIET_CLIENT_ID", "KIOTVIET_CLIENT_SECRET",
    "KIOTVIET_RETAILER", "KIOTVIET_WEBHOOK_SECRET", "SESSION_SECRET",
    "ADMIN_USERNAME", "ADMIN_PASSWORD",
  ];
  const missing = required.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  if (env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  return env;
}

export function resetEnvForTests(): void {
  cached = undefined;
}

export function getPublicAppUrl(): string {
  const env = getEnv();
  return (env.PUBLIC_APP_URL || env.APP_URL).replace(/\/$/, "");
}
