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
it("maps restock type, refunded subtotal and current quantity, and reads fulfilled units only for product refunds", async () => {
  const base = order();
  base.lineItems.nodes[0] = { ...base.lineItems.nodes[0], quantity: 3, currentQuantity: 2 } as typeof base.lineItems.nodes[0];
  graphql.mockResolvedValueOnce({ order: { ...base, refunds: [{ id: "gid://shopify/Refund/5" }],
    fulfillments: [{ id: "gid://shopify/Fulfillment/7", status: "SUCCESS" }, { id: "gid://shopify/Fulfillment/8", status: "CANCELLED" }] } });
  graphql.mockResolvedValueOnce({ refund: { id: "gid://shopify/Refund/5",
    refundLineItems: connection([{ quantity: 1, restockType: "CANCEL", lineItem: { id: "gid://shopify/LineItem/2" }, subtotalSet: money("80") }]),
    transactions: connection([{ kind: "REFUND", status: "SUCCESS", amountSet: money("80") }]) } });
  graphql.mockResolvedValueOnce({ fulfillment: { fulfillmentLineItems: connection([{ quantity: 2, lineItem: { id: "gid://shopify/LineItem/2" } }]) } });
  const snapshot = await getInvoiceOrder("1");
  expect(snapshot).toMatchObject({
    line_items: [{ id: 2, quantity: 3, current_quantity: 2 }],
    refunds: [{ refund_line_items: [{ line_item_id: 2, quantity: 1, restock_type: "cancel", subtotal: "80" }] }],
    fulfillments: [{ id: 7, status: "success", line_items: [{ id: 2, quantity: 2 }] }, { id: 8, status: "cancelled", line_items: [] }],
  });
  expect(graphql).toHaveBeenCalledTimes(3); // the cancelled fulfillment is not read
});
it("makes no fulfillment request when no refund names line items", async () => {
  graphql.mockResolvedValueOnce({ order: { ...order(), fulfillments: [{ id: "gid://shopify/Fulfillment/7", status: "SUCCESS" }] } });
  const snapshot = await getInvoiceOrder("1");
  expect(snapshot.fulfillments).toBeUndefined();
  expect(graphql).toHaveBeenCalledOnce();
});
