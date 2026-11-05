import { getEnv } from "@/lib/env";
import { clearShopifyAccessToken, getShopifyAccessToken } from "@/lib/shopify/auth";
import { ApiError, AuthenticationError, RateLimitError, RetryableError, UncertainResultError } from "@/lib/errors";
import type { ShopifyGraphqlResponse } from "@/types/shopify";

/**
 * `nonIdempotent`: a mutation whose repetition is not safe (e.g. refundCreate). Once the request
 * may have reached Shopify (network failure after sending, timeout, 5xx), it is never resent here;
 * an UncertainResultError is thrown and the caller must reconcile before trying again.
 * 401/403/429 responses mean Shopify did not execute it, so those are still retried.
 */
export async function shopifyGraphql<T>(query: string, variables: Record<string, unknown> = {}, options: { nonIdempotent?: boolean } = {}): Promise<T> {
  const env = getEnv();
  if (!env.SHOPIFY_SHOP) throw new AuthenticationError("Shopify credentials are not configured");
  const endpoint = `https://${env.SHOPIFY_SHOP}.myshopify.com/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  let token = await getShopifyAccessToken();
  let authenticationRetried = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }), cache: "no-store", signal: AbortSignal.timeout(20_000) });
    } catch {
      if (options.nonIdempotent) throw new UncertainResultError("Shopify mutation network failure or timeout; it may have been applied");
      if (attempt < 3) continue;
      throw new RetryableError("Shopify network request failed");
    }
    if (response.status === 401 && !authenticationRetried) {
      authenticationRetried = true;
      await clearShopifyAccessToken();
      token = await getShopifyAccessToken(true);
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new AuthenticationError(`Shopify authentication failed (${response.status})`);
    if (response.status === 429) {
      if (attempt < 3) { await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1))); continue; }
      throw new RateLimitError("Shopify rate limit exceeded");
    }
    if (response.status >= 500) {
      if (options.nonIdempotent) throw new UncertainResultError(`Shopify temporary error (${response.status}) on a mutation; it may have been applied`);
      if (attempt < 3) continue;
      throw new RetryableError(`Shopify temporary error (${response.status})`);
    }
    if (!response.ok) throw new ApiError(`Shopify HTTP error (${response.status})`, response.status);
    let payload: ShopifyGraphqlResponse<T>;
    try { payload = await response.json() as ShopifyGraphqlResponse<T>; } catch {
      if (options.nonIdempotent) throw new UncertainResultError("Shopify mutation returned an unreadable response; it may have been applied");
      throw new ApiError("Shopify returned invalid JSON");
    }
    if (payload.errors?.length) throw new ApiError(payload.errors.map(error => error.message).join("; "));
    if (!payload.data) throw new ApiError("Shopify response contains no data");
    const throttle = payload.extensions?.cost?.throttleStatus;
    if (throttle && throttle.currentlyAvailable < 100) await new Promise(resolve => setTimeout(resolve, Math.ceil((100 - throttle.currentlyAvailable) / throttle.restoreRate * 1_000)));
    return payload.data;
  }
  throw new RetryableError("Shopify request retries exhausted");
}
