import { getEnv } from "@/lib/env";
import { AuthenticationError, RetryableError } from "@/lib/errors";
import { getRedis, isRedisEnabled } from "@/lib/redis/client";

const REFRESH_EARLY_SECONDS = 60;
let localToken: { value: string; expiresAt: number } | undefined;
let tokenRequest: Promise<string> | undefined;
interface TokenResponse { access_token: string; expires_in: number }

function isTokenResponse(value: unknown): value is TokenResponse {
  const token = value as Partial<TokenResponse>;
  return Boolean(token) && typeof token.access_token === "string" && token.access_token.length > 0 && typeof token.expires_in === "number" && token.expires_in > 0;
}
function cacheKey(shop: string): string { return `shopify:access-token:${shop}`; }

export async function clearShopifyAccessToken(): Promise<void> {
  const { SHOPIFY_SHOP } = getEnv();
  if (isRedisEnabled()) await getRedis().del(cacheKey(SHOPIFY_SHOP)); else localToken = undefined;
}

async function requestAccessToken(): Promise<string> {
  const env = getEnv();
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new AuthenticationError("Shopify credentials are not configured");
  let response: Response;
  try {
    response = await fetch(`https://${env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }),
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new RetryableError("Could not connect to Shopify authentication service"); }
  if (!response.ok) throw new AuthenticationError(`Shopify authentication failed (${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new AuthenticationError("Shopify authentication returned invalid JSON"); }
  if (!isTokenResponse(payload)) throw new AuthenticationError("Shopify authentication response is invalid");
  const ttl = Math.max(1, payload.expires_in - REFRESH_EARLY_SECONDS);
  if (isRedisEnabled()) await getRedis().set(cacheKey(env.SHOPIFY_SHOP), payload.access_token, "EX", ttl);
  else localToken = { value: payload.access_token, expiresAt: Date.now() + ttl * 1_000 };
  return payload.access_token;
}

export async function getShopifyAccessToken(force = false): Promise<string> {
  const env = getEnv();
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new AuthenticationError("Shopify credentials are not configured");
  if (!force) {
    if (isRedisEnabled()) { const cached = await getRedis().get(cacheKey(env.SHOPIFY_SHOP)); if (cached) return cached; }
    else if (localToken && localToken.expiresAt > Date.now()) return localToken.value;
  }
  if (!tokenRequest) tokenRequest = requestAccessToken().finally(() => { tokenRequest = undefined; });
  return tokenRequest;
}

export function resetShopifyAuthForTests(): void { localToken = undefined; tokenRequest = undefined; }
