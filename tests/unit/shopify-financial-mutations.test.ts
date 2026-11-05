import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shopify/auth", () => ({ getShopifyAccessToken: async () => "token", clearShopifyAccessToken: async () => undefined }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ SHOPIFY_SHOP: "test-store", SHOPIFY_API_VERSION: "2026-07" }) }));

import { shopifyGraphql } from "@/lib/shopify/graphql";
import {
  createShopifyReturnRefund,
  getShopifyRefundTransactions,
  InsufficientRefundableAmountError,
  ShopifyRefundRejectedError,
} from "@/lib/shopify/orders";
import { RetryableError, UncertainResultError } from "@/lib/errors";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("non-idempotent Shopify mutations are never resent blindly", () => {
  it.each([
    ["a network failure", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
    ["a 5xx response", () => fetchMock.mockResolvedValueOnce(new Response("oops", { status: 502 }))],
    ["an unreadable response", () => fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }))],
  ])("%s → UncertainResultError after exactly one request", async (_label, arrange) => {
    arrange();
    await expect(shopifyGraphql("mutation X{x}", {}, { nonIdempotent: true })).rejects.toBeInstanceOf(UncertainResultError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still retries a 429 (Shopify did not execute it)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(json({ data: { ok: true } }));
    await expect(shopifyGraphql("mutation X{x}", {}, { nonIdempotent: true })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queries keep their automatic network retries", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({ data: { ok: true } }));
    await expect(shopifyGraphql("query X{x}")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockRejectedValue(new TypeError("fetch failed"));
    await expect(shopifyGraphql("query X{x}")).rejects.toBeInstanceOf(RetryableError);
  });

  it("refundCreate: a timeout is uncertain (one request), userErrors are a definite rejection", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(createShopifyReturnRefund("1", [], [], "TH1", "key")).rejects.toBeInstanceOf(UncertainResultError);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(json({ data: { refundCreate: { refund: null, userErrors: [{ message: "Amount too large" }] } } }));
    await expect(createShopifyReturnRefund("1", [], [], "TH1", "key")).rejects.toBeInstanceOf(ShopifyRefundRejectedError);
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(sent.variables).toMatchObject({ idempotencyKey: "key", input: { note: "Returned and refunded from KiotViet (TH1)." } });
  });
});

describe("refund payment allocation", () => {
  const transactions = (items: Array<[string, string, string, string?]>) => json({ data: { order: { transactions: items.map(([id, kind, amount, parent]) => ({
    id, kind, status: "SUCCESS", gateway: "shopify_payments", ...(parent ? { parentTransaction: { id: parent } } : {}), amountSet: { shopMoney: { amount, currencyCode: "USD" } } })) } } });

  it("allocates exact cents over the sale transactions", async () => {
    fetchMock.mockResolvedValueOnce(transactions([["s1", "SALE", "30.10"], ["s2", "SALE", "20.00"], ["r1", "REFUND", "10.05", "s1"]]));
    await expect(getShopifyRefundTransactions("1", 30.05)).resolves.toEqual([
      expect.objectContaining({ parentId: "s1", amount: "20.05" }), expect.objectContaining({ parentId: "s2", amount: "10.00" }),
    ]);
  });

  it("refuses when even one cent is missing (previously up to 1.00 was silently not refunded)", async () => {
    fetchMock.mockResolvedValueOnce(transactions([["s1", "SALE", "49.50"]]));
    await expect(getShopifyRefundTransactions("1", 50)).rejects.toBeInstanceOf(InsufficientRefundableAmountError);
  });
});
