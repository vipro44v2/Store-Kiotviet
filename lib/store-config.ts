import type { AppEnv } from "./env";

export const STORE_REQUIRED_ENV = [
  "DATABASE_URL", "REDIS_URL", "PUBLIC_APP_URL", "SHOPIFY_SHOP",
  "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "KIOTVIET_CLIENT_ID",
  "KIOTVIET_CLIENT_SECRET", "KIOTVIET_RETAILER", "KIOTVIET_WEBHOOK_SECRET",
  "SESSION_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD",
] as const satisfies ReadonlyArray<keyof AppEnv>;

export function validateStoreConfig(env: AppEnv): string[] {
  const errors = STORE_REQUIRED_ENV
    .filter((key) => !String(env[key] ?? "").trim())
    .map((key) => `${key} is required`);
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32)
    errors.push("SESSION_SECRET must contain at least 32 characters");
  if (env.PUBLIC_APP_URL && !env.PUBLIC_APP_URL.startsWith("https://"))
    errors.push("PUBLIC_APP_URL must use HTTPS for production webhooks");
  return errors;
}
