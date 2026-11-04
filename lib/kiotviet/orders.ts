import { UncertainResultError } from "@/lib/errors";
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
/**
 * Creating an order is not idempotent: a timeout or 5xx may still have created
 * it. Never resend automatically; callers verify with
 * findKiotVietOrderByShopifyReference before trying again.
 */
export async function createKiotVietOrder(input: KiotVietOrderInput) {
  const created = await kiotVietClient.post<{ id: number; code: string }>(
    "/orders",
    input,
    { nonIdempotent: true },
  );
  if (!created || !Number.isSafeInteger(Number(created.id)) || Number(created.id) <= 0)
    throw new UncertainResultError(
      "KiotViet order creation returned no order ID; the order may have been created",
    );
  return created;
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
/** GET /orders/{id}. Status 3 = completed, 4 = cancelled (as used by order status sync). */
export interface KiotVietOrderDetail {
  id: number;
  code: string;
  branchId: number;
  status: number;
  statusValue?: string;
  customerId?: number | null;
  total?: number;
  totalPayment?: number;
  description?: string | null;
  purchaseDate?: string;
  createdDate?: string;
  orderDetails?: Array<{ productId: number; productCode?: string; productName?: string; quantity: number; price: number; discount?: number | null }>;
  payments?: Array<{ amount?: number | null }> | null;
}
export function getKiotVietOrder(id: number) {
  return kiotVietClient.get<KiotVietOrderDetail>(`/orders/${id}`);
}
