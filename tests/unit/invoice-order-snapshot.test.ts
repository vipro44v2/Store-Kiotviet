import { beforeEach, expect, it, vi } from "vitest";
const graphql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify/graphql", () => ({ shopifyGraphql: graphql }));
import { getInvoiceOrder } from "@/lib/shopify/invoice-order";
const money = (amount: string) => ({ shopMoney: { amount } });
const connection = <T>(nodes: T[], hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });
const order = () => ({ id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-11-02", updatedAt: "2026-11-03",
  cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", currencyCode: "USD", taxesIncluded: false,
  totalPriceSet: money("83.33"), totalTipReceivedSet: money("0"), refunds: [], shippingLines: connection([]),
  lineItems: connection([{ id: "gid://shopify/LineItem/2", sku: "SKU", title: "Product", quantity: 1,
    variant: { id: "gid://shopify/ProductVariant/3", product: { id: "gid://shopify/Product/4" } },
    originalUnitPriceSet: money("80"), discountAllocations: [], taxLines: [] }]),
});
beforeEach(() => graphql.mockReset());
it("maps authoritative financial and fulfillment state without webhook data", async () => {
  graphql.mockResolvedValue({ order: order() });
  expect(await getInvoiceOrder("1")).toMatchObject({ id: 1, fulfillment_status: "fulfilled", financial_status: "paid",
    updated_at: "2026-11-03", line_items: [{ id: 2, product_id: 4, variant_id: 3, price: "80" }] });
});
it("fails closed when a child connection is truncated", async () => {
  const data = order(); data.lineItems.pageInfo.hasNextPage = true;
  graphql.mockResolvedValue({ order: data });
  await expect(getInvoiceOrder("1")).rejects.toThrow("invoice_snapshot_incomplete");
});
it("loads refund transactions and affected lines separately", async () => {
  graphql.mockResolvedValueOnce({ order: { ...order(), refunds: [{ id: "gid://shopify/Refund/5" }] } });
  graphql.mockResolvedValueOnce({ refund: { id: "gid://shopify/Refund/5",
    refundLineItems: connection([{ quantity: 1, lineItem: { id: "gid://shopify/LineItem/6" } }]),
    transactions: connection([{ kind: "REFUND", status: "SUCCESS", amountSet: money("3.33") }]) } });
  expect(await getInvoiceOrder("1")).toMatchObject({ refunds: [{ id: 5,
    refund_line_items: [{ line_item_id: 6, quantity: 1 }], transactions: [{ kind: "refund", status: "success", amount: "3.33" }] }] });
});
