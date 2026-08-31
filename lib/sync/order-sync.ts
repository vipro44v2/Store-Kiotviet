import type { ShopifyOrderWebhook } from "@/types/shopify";
import { MappingError, PermanentError, RetryableError } from "@/lib/errors";
import { normalizeSku } from "./mappings";
import { mappingsRepository } from "@/repositories/mappings";
import {
  createKiotVietOrder,
  cancelKiotVietOrder,
  findKiotVietOrderByShopifyReference,
  updateKiotVietOrderCustomer,
} from "@/lib/kiotviet/orders";
import { transaction } from "@/lib/db/client";
import { syncShopifyCustomer } from "./customer-sync";
import {
  cancelShopifyOrderById,
  fulfillShopifyOrderById,
} from "@/lib/shopify/orders";
import { getActiveKiotVietBranches } from "@/lib/kiotviet/branches";
import type { PoolClient } from "pg";

interface OrderSettings {
  autoCreate?: boolean;
  paidOnly?: boolean;
  syncCustomers?: boolean;
  syncCancellation?: boolean;
  defaultBranchId?: number | string;
}

export async function resolveDefaultBranchId(
  client: PoolClient,
  settings: OrderSettings,
): Promise<number> {
  const configuredBranchId = Number(settings.defaultBranchId);
  if (Number.isInteger(configuredBranchId) && configuredBranchId > 0)
    return configuredBranchId;

  const activeBranches = await getActiveKiotVietBranches();
  if (!activeBranches.length)
    throw new PermanentError(
      "No active KiotViet branches exist; configure a default branch manually",
    );
  if (activeBranches.length > 1)
    throw new PermanentError(
      "Multiple active KiotViet branches exist; configure orders.defaultBranchId manually",
    );

  const branchId = activeBranches[0].id;
  const updated = await client.query<{ default_branch_id: string }>(
    `INSERT INTO system_settings(key,value,updated_at)
    VALUES('orders',jsonb_build_object('defaultBranchId',$1::bigint),now())
    ON CONFLICT(key) DO UPDATE SET
      value=system_settings.value || EXCLUDED.value,
      updated_at=now()
    WHERE system_settings.value->>'defaultBranchId' IS NULL
      OR system_settings.value->>'defaultBranchId' !~ '^[1-9][0-9]*$'
    RETURNING value->>'defaultBranchId' AS default_branch_id`,
    [branchId],
  );
  if (updated.rows[0]?.default_branch_id)
    return Number(updated.rows[0].default_branch_id);

  const current = await client.query<{ default_branch_id: string }>(
    "SELECT value->>'defaultBranchId' AS default_branch_id FROM system_settings WHERE key='orders'",
  );
  const currentBranchId = Number(current.rows[0]?.default_branch_id);
  if (Number.isInteger(currentBranchId) && currentBranchId > 0)
    return currentBranchId;
  throw new PermanentError(
    "Default KiotViet branch could not be initialized; configure orders.defaultBranchId manually",
  );
}

export const ORDER_RECOVERY_WINDOW_MS = 5 * 60_000;
export function isOrderRecoveryWindowOpen(
  createdAt: string | Date,
  now = new Date(),
) {
  return (
    now.getTime() - new Date(createdAt).getTime() < ORDER_RECOVERY_WINDOW_MS
  );
}

export async function syncShopifyOrder(order: ShopifyOrderWebhook) {
  const orderId = String(order.id);
  const claimed = await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`shopify-order:${orderId}`],
    );
    const existing = await client.query(
      "SELECT 1 FROM order_mappings WHERE shopify_order_id=$1",
      [orderId],
    );
    if (existing.rowCount) return false;
    const settingsResult = await client.query<{ value: OrderSettings }>(
      "SELECT value FROM system_settings WHERE key='orders'",
    );
    const settings = settingsResult.rows[0]?.value ?? {};
    if (
      settings.autoCreate === false ||
      (settings.paidOnly !== false && order.financial_status !== "paid")
    )
      return false;
    await client.query(
      "INSERT INTO order_mappings(shopify_order_id,shopify_order_number,status,financial_status,fulfillment_status,sync_status) VALUES($1,$2,'creating',$3,$4,'pending')",
      [
        orderId,
        order.name,
        order.financial_status,
        order.fulfillment_status ?? null,
      ],
    );
    return true;
  });

  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`shopify-order:${orderId}`],
    );

    const settingsResult = await client.query<{ value: OrderSettings }>(
      "SELECT value FROM system_settings WHERE key='orders'",
    );
    const settings = settingsResult.rows[0]?.value ?? {};
    const existing = await client.query<{
      kiotviet_order_id: string | null;
      status: string | null;
      created_at: string | Date;
    }>(
      "SELECT kiotviet_order_id,status,created_at FROM order_mappings WHERE shopify_order_id=$1",
      [orderId],
    );
    if (existing.rowCount && !claimed) {
      let status = existing.rows[0]?.status ?? "created";
      if (status === "creating" && !existing.rows[0]?.kiotviet_order_id) {
        const recovered = await findKiotVietOrderByShopifyReference(orderId);
        if (recovered) {
          await client.query(
            "UPDATE order_mappings SET kiotviet_order_id=$2,kiotviet_order_code=$3,status='created',financial_status=$4,fulfillment_status=$5,sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1 AND status='creating'",
            [
              orderId,
              recovered.id,
              recovered.code,
              order.financial_status,
              order.fulfillment_status ?? null,
            ],
          );
          return;
        }
        if (isOrderRecoveryWindowOpen(existing.rows[0].created_at))
          throw new RetryableError(
            `Order ${order.id} is still inside the recovery window`,
          );
      } else {
        if (
          settings.syncCustomers !== false &&
          order.customer &&
          existing.rows[0]?.kiotviet_order_id &&
          status === "created"
        ) {
          await syncShopifyCustomer(order.customer);
          const customer = await client.query<{ kiotviet_customer_id: string }>(
            "SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id=$1",
            [String(order.customer.id)],
          );
          if (customer.rows[0]?.kiotviet_customer_id)
            await updateKiotVietOrderCustomer(
              Number(existing.rows[0].kiotviet_order_id),
              Number(customer.rows[0].kiotviet_customer_id),
            );
        }
        await client.query(
          "UPDATE order_mappings SET status=$4,financial_status=$2,fulfillment_status=$3,sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1",
          [
            orderId,
            order.financial_status,
            order.fulfillment_status ?? null,
            status,
          ],
        );
        return;
      }
    }

    if (settings.autoCreate === false) return;
    if (settings.paidOnly !== false && order.financial_status !== "paid")
      return;

    const branchId = await resolveDefaultBranchId(client, settings);

    let customerId: number | undefined;
    if (settings.syncCustomers !== false && order.customer) {
      await syncShopifyCustomer(order.customer, branchId);
      const customer = await client.query<{ kiotviet_customer_id: string }>(
        "SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id=$1",
        [String(order.customer.id)],
      );
      customerId = customer.rows[0]?.kiotviet_customer_id
        ? Number(customer.rows[0].kiotviet_customer_id)
        : undefined;
    }

    const details = [];
    for (const line of order.line_items) {
      const sku = normalizeSku(line.sku);
      const maps = await mappingsRepository.findBySku(sku);
      if (maps.length !== 1 || !maps[0].kiotviet_product_id)
        throw new MappingError(
          `Missing or ambiguous mapping for SKU ${sku || "(empty)"}`,
        );
      details.push({
        productId: Number(maps[0].kiotviet_product_id),
        productCode: line.sku,
        productName: line.name,
        quantity: line.quantity,
        price: Number(line.price),
        discount: 0,
      });
    }

    const created = await createKiotVietOrder({
      branchId,
      customer: customerId ? { id: customerId } : undefined,
      description: `Shopify ${order.name} (${order.id})`,
      discount: 0,
      method: "Transfer",
      totalPayment:
        order.financial_status === "paid" ? Number(order.total_price) : 0,
      makeInvoice: false,
      orderDetails: details,
    });

    await client.query(
      "UPDATE order_mappings SET kiotviet_order_id=$2,kiotviet_order_code=$3,status='created',financial_status=$4,fulfillment_status=$5,sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1 AND status='creating'",
      [
        orderId,
        created.id,
        created.code,
        order.financial_status,
        order.fulfillment_status ?? null,
      ],
    );
  });
}

export async function cancelShopifyOrder(order: ShopifyOrderWebhook) {
  await transaction(async (client) => {
    const orderId = String(order.id);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`shopify-order:${orderId}`],
    );
    const result = await client.query<{
      kiotviet_order_id: string;
      status: string | null;
    }>(
      "SELECT kiotviet_order_id,status FROM order_mappings WHERE shopify_order_id=$1",
      [orderId],
    );
    if (!result.rows[0]?.kiotviet_order_id)
      throw new MappingError(`Order ${order.id} is not mapped`);
    if (result.rows[0].status !== "cancelled")
      await cancelKiotVietOrder(Number(result.rows[0].kiotviet_order_id));
    await client.query(
      "UPDATE order_mappings SET status='cancelled',sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1",
      [orderId],
    );
  });
}

export interface KiotVietOrderUpdate {
  Id?: number;
  id?: number;
  Code?: string;
  code?: string;
  Status?: number;
  status?: number;
  StatusValue?: string;
  statusValue?: string;
}
export interface KiotVietInvoiceUpdate {
  Id?: number;
  id?: number;
  Code?: string;
  code?: string;
  OrderCode?: string;
  orderCode?: string;
  Status?: number;
  status?: number;
  InvoiceDelivery?: {
    DeliveryCode?: string;
    deliveryCode?: string;
    PartnerDelivery?: { Name?: string; name?: string };
    partnerDelivery?: { Name?: string; name?: string };
  };
  invoiceDelivery?: {
    DeliveryCode?: string;
    deliveryCode?: string;
    PartnerDelivery?: { Name?: string; name?: string };
    partnerDelivery?: { Name?: string; name?: string };
  };
}
export async function syncKiotVietInvoice(invoice: KiotVietInvoiceUpdate) {
  const orderCode = String(invoice.OrderCode ?? invoice.orderCode ?? "");
  if (!orderCode)
    throw new MappingError("KiotViet invoice webhook has no order code");
  const delivery = invoice.InvoiceDelivery ?? invoice.invoiceDelivery,
    trackingNumber = String(
      delivery?.DeliveryCode ?? delivery?.deliveryCode ?? "",
    ).trim(),
    partner = delivery?.PartnerDelivery ?? delivery?.partnerDelivery,
    company = String(partner?.Name ?? partner?.name ?? "").trim();
  return transaction(async (client) => {
    const result = await client.query<{
      shopify_order_id: string;
      kiotviet_order_id: string;
    }>(
      "SELECT shopify_order_id,kiotviet_order_id FROM order_mappings WHERE kiotviet_order_code=$1",
      [orderCode],
    );
    if (result.rowCount !== 1)
      throw new MappingError(
        `KiotViet order ${orderCode} is not uniquely mapped`,
      );
    const fulfilled = await fulfillShopifyOrderById(
      result.rows[0].shopify_order_id,
      orderCode,
      trackingNumber
        ? { number: trackingNumber, company: company || undefined }
        : undefined,
    );
    if (trackingNumber)
      await client.query(
        "INSERT INTO fulfillment_mappings(shopify_fulfillment_id,shopify_order_id,kiotviet_order_id,tracking_number,status) VALUES($1,$2,$3,$4,'synced') ON CONFLICT(shopify_fulfillment_id) DO UPDATE SET tracking_number=EXCLUDED.tracking_number,status='synced',updated_at=now()",
        [
          `kiotviet-invoice-${invoice.Id ?? invoice.id}`,
          result.rows[0].shopify_order_id,
          result.rows[0].kiotviet_order_id,
          trackingNumber,
        ],
      );
    return fulfilled;
  });
}

export async function syncKiotVietOrderStatus(order: KiotVietOrderUpdate) {
  const kiotVietOrderId = String(order.Id ?? order.id ?? "");
  if (!kiotVietOrderId)
    throw new MappingError("KiotViet order webhook has no order ID");
  const status = Number(order.Status ?? order.status);
  const statusValue = String(
    order.StatusValue ?? order.statusValue ?? "",
  ).toLocaleLowerCase("vi");
  const cancelled =
    status === 4 || statusValue.includes("hủy") || statusValue.includes("huy");
  const completed =
    status === 3 ||
    statusValue.includes("completed") ||
    statusValue.includes("hoàn thành");
  if (!cancelled && !completed)
    return { updated: false, reason: "no_terminal_status" };

  return transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`kiotviet-order:${kiotVietOrderId}`],
    );
    const result = await client.query<{
      shopify_order_id: string;
      status: string | null;
      kiotviet_order_code: string | null;
    }>(
      "SELECT shopify_order_id,status,kiotviet_order_code FROM order_mappings WHERE kiotviet_order_id=$1",
      [kiotVietOrderId],
    );
    const mapping = result.rows[0];
    if (!mapping)
      throw new MappingError(`KiotViet order ${kiotVietOrderId} is not mapped`);
    const code = mapping.kiotviet_order_code ?? order.Code ?? order.code;
    if (cancelled) {
      if (mapping.status === "cancelled")
        return { updated: false, reason: "already_cancelled" };
      await cancelShopifyOrderById(mapping.shopify_order_id, code);
      await client.query(
        "UPDATE order_mappings SET status='cancelled',sync_status='synced',last_sync_at=now(),updated_at=now() WHERE kiotviet_order_id=$1",
        [kiotVietOrderId],
      );
      return {
        updated: true,
        action: "cancelled",
        shopifyOrderId: mapping.shopify_order_id,
      };
    }
    if (mapping.status === "cancelled")
      return { updated: false, reason: "shopify_order_cancelled" };
    if (mapping.status === "completed")
      return { updated: false, reason: "already_completed" };
    await fulfillShopifyOrderById(mapping.shopify_order_id, code);
    await client.query(
      "UPDATE order_mappings SET status='completed',fulfillment_status='fulfilled',sync_status='synced',last_sync_at=now(),updated_at=now() WHERE kiotviet_order_id=$1",
      [kiotVietOrderId],
    );
    return {
      updated: true,
      action: "fulfilled",
      shopifyOrderId: mapping.shopify_order_id,
    };
  });
}

export const syncKiotVietOrderCancellation = syncKiotVietOrderStatus;
