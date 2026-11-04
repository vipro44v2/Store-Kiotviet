import { shopifyGraphql } from "./graphql";
import { PermanentError } from "@/lib/errors";
import type { ShopifyOrderWebhook } from "@/types/shopify";

type Money = { shopMoney: { amount: string } };
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };
interface InvoiceOrder {
  id: string; name: string; createdAt: string; updatedAt: string; cancelledAt: string | null;
  displayFinancialStatus: string; displayFulfillmentStatus: string; currencyCode: string;
  totalPriceSet: Money; totalTipReceivedSet: Money; taxesIncluded: boolean;
  lineItems: Connection<{ id: string; sku: string | null; title: string; quantity: number;
    variant: { id: string; product: { id: string } } | null; originalUnitPriceSet: Money;
    discountAllocations: Array<{ allocatedAmountSet: Money }>; taxLines: Array<{ priceSet: Money }> }>;
  shippingLines: Connection<{ discountedPriceSet: Money; taxLines: Array<{ priceSet: Money }> }>;
  refunds: Array<{ id: string; refundLineItems: Connection<{ quantity: number; lineItem: { id: string } }>;
    transactions: Connection<{ kind: string; status: string; amountSet: Money }> }>;
}
const numericId = (id: string) => Number(id.split("/").pop());

/** Complete bounded financial snapshot. Oversized connections fail closed, never silently truncate. */
export async function getInvoiceOrder(orderId: string): Promise<ShopifyOrderWebhook> {
  const { order } = await shopifyGraphql<{ order: Omit<InvoiceOrder, "refunds"> & { refunds: Array<{ id: string }> } | null }>(`query InvoiceOrder($id:ID!){order(id:$id){
    id name createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus currencyCode taxesIncluded
    totalPriceSet{shopMoney{amount}} totalTipReceivedSet{shopMoney{amount}}
    lineItems(first:100){pageInfo{hasNextPage} nodes{id sku title quantity variant{id product{id}}
      originalUnitPriceSet{shopMoney{amount}} discountAllocations{allocatedAmountSet{shopMoney{amount}}} taxLines{priceSet{shopMoney{amount}}}}}
    shippingLines(first:20){pageInfo{hasNextPage} nodes{discountedPriceSet{shopMoney{amount}} taxLines{priceSet{shopMoney{amount}}}}}
    refunds(first:101){id}
  }}`, { id: `gid://shopify/Order/${orderId}` });
  if (!order) throw new PermanentError("Shopify order missing");
  if (order.refunds.length >= 101) throw new PermanentError("invoice_snapshot_incomplete: refund limit reached");
  // Fetch refunds separately to stay below Shopify's maximum query cost.
  const refunds: InvoiceOrder["refunds"] = [];
  for (const reference of order.refunds) {
    const { refund } = await shopifyGraphql<{ refund: InvoiceOrder["refunds"][number] | null }>(      `query InvoiceRefund($id:ID!){refund(id:$id){id
        refundLineItems(first:100){pageInfo{hasNextPage} nodes{quantity lineItem{id}}}
        transactions(first:100){pageInfo{hasNextPage} nodes{kind status amountSet{shopMoney{amount}}}}
      }}`, { id: reference.id });
    if (!refund) throw new PermanentError("invoice_snapshot_incomplete: refund missing");
    refunds.push(refund);
  }
  const connections = [order.lineItems, order.shippingLines, ...refunds.flatMap(r => [r.refundLineItems, r.transactions])];
  if (connections.some(c => c.pageInfo.hasNextPage)) throw new PermanentError("invoice_snapshot_incomplete: child record limit reached; manual review required");
  return {
    id: numericId(order.id), name: order.name, created_at: order.createdAt, updated_at: order.updatedAt,
    cancelled_at: order.cancelledAt, financial_status: order.displayFinancialStatus.toLowerCase(),
    fulfillment_status: order.displayFulfillmentStatus.toLowerCase(), currency: order.currencyCode,
    total_price: order.totalPriceSet.shopMoney.amount, total_tip_received: order.totalTipReceivedSet.shopMoney.amount,
    taxes_included: order.taxesIncluded,
    line_items: order.lineItems.nodes.map(l => ({ id: numericId(l.id), sku: l.sku, title: l.title, quantity: l.quantity,
      variant_id: l.variant ? numericId(l.variant.id) : null, product_id: l.variant ? numericId(l.variant.product.id) : null,
      price: l.originalUnitPriceSet.shopMoney.amount,
      discount_allocations: l.discountAllocations.map(d => ({ amount: d.allocatedAmountSet.shopMoney.amount })),
      tax_lines: l.taxLines.map(t => ({ price: t.priceSet.shopMoney.amount })) })),
    shipping_lines: order.shippingLines.nodes.map(s => ({ discounted_price: s.discountedPriceSet.shopMoney.amount,
      tax_lines: s.taxLines.map(t => ({ price: t.priceSet.shopMoney.amount })) })),
    refunds: refunds.map(r => ({ id: numericId(r.id),
      refund_line_items: r.refundLineItems.nodes.map(l => ({ line_item_id: numericId(l.lineItem.id), quantity: l.quantity })),
      transactions: r.transactions.nodes.map(t => ({ kind: t.kind.toLowerCase(), status: t.status.toLowerCase(), amount: t.amountSet.shopMoney.amount })) })),
  };
}
