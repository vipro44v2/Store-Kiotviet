import { shopifyGraphql } from "./graphql";
import { PermanentError } from "@/lib/errors";
import type { ShopifyFulfillment, ShopifyOrderWebhook } from "@/types/shopify";

type Money = { shopMoney: { amount: string } };
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };
interface InvoiceOrder {
  id: string; name: string; createdAt: string; updatedAt: string; cancelledAt: string | null;
  displayFinancialStatus: string; displayFulfillmentStatus: string; currencyCode: string;
  totalPriceSet: Money; totalTipReceivedSet: Money; taxesIncluded: boolean;
  lineItems: Connection<{ id: string; sku: string | null; title: string; quantity: number; currentQuantity?: number | null;
    variant: { id: string; product: { id: string } } | null; originalUnitPriceSet: Money;
    discountAllocations: Array<{ allocatedAmountSet: Money }>; taxLines: Array<{ priceSet: Money }> }>;
  shippingLines: Connection<{ discountedPriceSet: Money; taxLines: Array<{ priceSet: Money }> }>;
  refunds: Array<{ id: string; refundLineItems: Connection<{ quantity: number; restockType?: string | null; lineItem: { id: string }; subtotalSet?: Money | null }>;
    transactions: Connection<{ kind: string; status: string; amountSet: Money }> }>;
  fulfillments?: Array<{ id: string; status: string }>;
}
const numericId = (id: string) => Number(id.split("/").pop());
/** Fulfillments read per order (enough for real orders); more fails closed when they are needed. */
const FULFILLMENT_LIMIT = 20;

/**
 * Complete bounded financial snapshot. Oversized connections fail closed, never silently truncate.
 * `quantity` is the original ordered quantity; `currentQuantity`, refund `restockType` and the
 * fulfilled quantities feed the refunded-quantity adjustments (lib/sync/product-only-invoicing.ts).
 * Fulfillment line items are only read when a refund touches line items (no extra request otherwise).
 */
export async function getInvoiceOrder(orderId: string): Promise<ShopifyOrderWebhook> {
  const { order } = await shopifyGraphql<{ order: Omit<InvoiceOrder, "refunds"> & { refunds: Array<{ id: string }> } | null }>(`query InvoiceOrder($id:ID!){order(id:$id){
    id name createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus currencyCode taxesIncluded
    totalPriceSet{shopMoney{amount}} totalTipReceivedSet{shopMoney{amount}}
    lineItems(first:100){pageInfo{hasNextPage} nodes{id sku title quantity currentQuantity variant{id product{id}}
      originalUnitPriceSet{shopMoney{amount}} discountAllocations{allocatedAmountSet{shopMoney{amount}}} taxLines{priceSet{shopMoney{amount}}}}}
    shippingLines(first:20){pageInfo{hasNextPage} nodes{discountedPriceSet{shopMoney{amount}} taxLines{priceSet{shopMoney{amount}}}}}
    refunds(first:101){id}
    fulfillments(first:${FULFILLMENT_LIMIT}){id status}
  }}`, { id: `gid://shopify/Order/${orderId}` });
  if (!order) throw new PermanentError("Shopify order missing");
  if (order.refunds.length >= 101) throw new PermanentError("invoice_snapshot_incomplete: refund limit reached");
  // Fetch refunds separately to stay below Shopify's maximum query cost.
  const refunds: InvoiceOrder["refunds"] = [];
  for (const reference of order.refunds) {
    const { refund } = await shopifyGraphql<{ refund: InvoiceOrder["refunds"][number] | null }>(      `query InvoiceRefund($id:ID!){refund(id:$id){id
        refundLineItems(first:100){pageInfo{hasNextPage} nodes{quantity restockType lineItem{id} subtotalSet{shopMoney{amount}}}}
        transactions(first:100){pageInfo{hasNextPage} nodes{kind status amountSet{shopMoney{amount}}}}
      }}`, { id: reference.id });
    if (!refund) throw new PermanentError("invoice_snapshot_incomplete: refund missing");
    refunds.push(refund);
  }
  const connections: Array<Connection<unknown>> = [order.lineItems, order.shippingLines, ...refunds.flatMap(r => [r.refundLineItems, r.transactions])];
  // Which units were shipped matters only when refunds name line items.
  let fulfillments: ShopifyFulfillment[] | undefined;
  if (refunds.some((refund) => refund.refundLineItems.nodes.some((item) => item.quantity > 0))) {
    const list = order.fulfillments ?? [];
    if (list.length >= FULFILLMENT_LIMIT) throw new PermanentError("invoice_snapshot_incomplete: fulfillment limit reached; manual review required");
    fulfillments = [];
    for (const reference of list) {
      const status = reference.status.toLowerCase();
      if (status !== "success") { fulfillments.push({ id: numericId(reference.id), status, line_items: [] }); continue; }
      const { fulfillment } = await shopifyGraphql<{ fulfillment: { fulfillmentLineItems: Connection<{ quantity: number; lineItem: { id: string } }> } | null }>(
        `query InvoiceFulfillment($id:ID!){fulfillment(id:$id){fulfillmentLineItems(first:100){pageInfo{hasNextPage} nodes{quantity lineItem{id}}}}}`,
        { id: reference.id });
      if (!fulfillment) throw new PermanentError("invoice_snapshot_incomplete: fulfillment missing");
      connections.push(fulfillment.fulfillmentLineItems);
      fulfillments.push({ id: numericId(reference.id), status,
        line_items: fulfillment.fulfillmentLineItems.nodes.map((item) => ({ id: numericId(item.lineItem.id), quantity: item.quantity })) });
    }
  }
  if (connections.some(c => c.pageInfo.hasNextPage)) throw new PermanentError("invoice_snapshot_incomplete: child record limit reached; manual review required");
  return {
    id: numericId(order.id), name: order.name, created_at: order.createdAt, updated_at: order.updatedAt,
    cancelled_at: order.cancelledAt, financial_status: order.displayFinancialStatus.toLowerCase(),
    fulfillment_status: order.displayFulfillmentStatus.toLowerCase(), currency: order.currencyCode,
    total_price: order.totalPriceSet.shopMoney.amount, total_tip_received: order.totalTipReceivedSet.shopMoney.amount,
    taxes_included: order.taxesIncluded,
    line_items: order.lineItems.nodes.map(l => ({ id: numericId(l.id), sku: l.sku, title: l.title, quantity: l.quantity,
      ...(l.currentQuantity != null ? { current_quantity: l.currentQuantity } : {}),
      variant_id: l.variant ? numericId(l.variant.id) : null, product_id: l.variant ? numericId(l.variant.product.id) : null,
      price: l.originalUnitPriceSet.shopMoney.amount,
      discount_allocations: l.discountAllocations.map(d => ({ amount: d.allocatedAmountSet.shopMoney.amount })),
      tax_lines: l.taxLines.map(t => ({ price: t.priceSet.shopMoney.amount })) })),
    shipping_lines: order.shippingLines.nodes.map(s => ({ discounted_price: s.discountedPriceSet.shopMoney.amount,
      tax_lines: s.taxLines.map(t => ({ price: t.priceSet.shopMoney.amount })) })),
    refunds: refunds.map(r => ({ id: numericId(r.id),
      refund_line_items: r.refundLineItems.nodes.map(l => ({ line_item_id: numericId(l.lineItem.id), quantity: l.quantity,
        ...(l.restockType ? { restock_type: l.restockType.toLowerCase() } : {}),
        ...(l.subtotalSet ? { subtotal: l.subtotalSet.shopMoney.amount } : {}) })),
      transactions: r.transactions.nodes.map(t => ({ kind: t.kind.toLowerCase(), status: t.status.toLowerCase(), amount: t.amountSet.shopMoney.amount })) })),
    ...(fulfillments ? { fulfillments } : {}),
  };
}
