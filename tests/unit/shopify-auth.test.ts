import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/lib/env";
import { getShopifyAccessToken, resetShopifyAuthForTests } from "@/lib/shopify/auth";
import { shopifyGraphql } from "@/lib/shopify/graphql";

beforeEach(() => {
  process.env.REDIS_URL = "";
  process.env.SHOPIFY_SHOP = "test-store";
  process.env.SHOPIFY_CLIENT_ID = "client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "client-secret";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  resetEnvForTests();
  resetShopifyAuthForTests();
  vi.restoreAllMocks();
});

describe("Shopify client credentials", () => {
  it("requests and caches a token before its refresh window", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), { status: 200 }));
    expect(await getShopifyAccessToken()).toBe("token-1");
    expect(await getShopifyAccessToken()).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://test-store.myshopify.com/admin/oauth/access_token");
    expect(String(options?.body)).toContain("grant_type=client_credentials");
    expect(String(options?.body)).toContain("client_id=client-id");
  });

  it("clears the token and retries a Shopify 401 exactly once", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { shop: { id: "gid://shopify/Shop/1" } } }), { status: 200 }));
    await expect(shopifyGraphql<{ shop: { id: string } }>("query { shop { id } }")).resolves.toEqual({ shop: { id: "gid://shopify/Shop/1" } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({ "X-Shopify-Access-Token": "fresh" });
  });

  it("does not retry a second Shopify 401", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(shopifyGraphql("query { shop { id } }")).rejects.toThrow("Shopify authentication failed (401)");
  });
});
