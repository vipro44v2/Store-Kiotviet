import { kiotVietClient } from "./client";
export interface KiotVietOrderInput {
  branchId: number;
  purchaseDate?: string;
  description: string;
  discount: number;
  method: string;
  totalPayment: number;
  makeInvoice: boolean;
  customer?: { id: number };
  orderDetails: Array<{
    productId: number;
    productCode: string;
    productName: string;
    quantity: number;
    price: number;
    discount?: number;
  }>;
}
export interface KiotVietOrderSummary {
  id: number;
  code: string;
  description?: string;
}
export function createKiotVietOrder(input: KiotVietOrderInput) {
  return kiotVietClient.post<{ id: number; code: string }>("/orders", input);
}
export function matchKiotVietOrderByShopifyReference(
  orders: KiotVietOrderSummary[],
  shopifyOrderId: string,
) {
  const reference = `(${shopifyOrderId})`;
  return orders.find((order) => order.description?.includes(reference));
}
export async function findKiotVietOrderByShopifyReference(
  shopifyOrderId: string,
) {
  const params = new URLSearchParams({
    searchTerm: shopifyOrderId,
    pageSize: "100",
    currentItem: "0",
  });
  const result = await kiotVietClient.get<{ data: KiotVietOrderSummary[] }>(
    `/orders?${params}`,
  );
  return matchKiotVietOrderByShopifyReference(
    result.data ?? [],
    shopifyOrderId,
  );
}
export function updateKiotVietOrderCustomer(id: number, customerId: number) {
  return kiotVietClient.put(`/orders/${id}`, { customer: { id: customerId } });
}
export async function cancelKiotVietOrder(id: number) {
  const order = await kiotVietClient.get<{ status: number }>(`/orders/${id}`);
  if (order.status === 4) return { message: "Order is already cancelled" };
  return kiotVietClient.delete<{ message: string }>(
    `/orders/${id}?IsVoidPayment=true`,
  );
}
