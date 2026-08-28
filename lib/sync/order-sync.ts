import type { ShopifyOrderWebhook } from "@/types/shopify";
import { MappingError, PermanentError } from "@/lib/errors";
import { normalizeSku } from "./mappings";
import { mappingsRepository } from "@/repositories/mappings";
import { createKiotVietOrder, cancelKiotVietOrder } from "@/lib/kiotviet/orders";
import { transaction } from "@/lib/db/client";
import { syncShopifyCustomer } from "./customer-sync";

interface OrderSettings {
  autoCreate?: boolean;
  paidOnly?: boolean;
  syncCustomers?: boolean;
  syncCancellation?: boolean;
  defaultBranchId?: number | string;
}

export async function syncShopifyOrder(order: ShopifyOrderWebhook) {
  await transaction(async (client) => {
    const orderId = String(order.id);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shopify-order:${orderId}`]);

    const settingsResult = await client.query<{ value: OrderSettings }>("SELECT value FROM system_settings WHERE key='orders'");
    const settings = settingsResult.rows[0]?.value ?? {};
    const existing = await client.query<{ kiotviet_order_id: string | null; status: string | null }>("SELECT kiotviet_order_id,status FROM order_mappings WHERE shopify_order_id=$1", [orderId]);
    if (existing.rowCount) {
      let status = existing.rows[0]?.status ?? "created";
      if (settings.syncCancellation !== false && order.financial_status === "refunded" && existing.rows[0]?.kiotviet_order_id && status !== "cancelled") {
        await cancelKiotVietOrder(Number(existing.rows[0].kiotviet_order_id));
        status = "cancelled";
      }
      await client.query("UPDATE order_mappings SET status=$4,financial_status=$2,fulfillment_status=$3,sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1", [orderId, order.financial_status, order.fulfillment_status ?? null, status]);
      return;
    }

    if (settings.autoCreate === false) return;
    if (settings.paidOnly !== false && order.financial_status !== "paid") return;

    const branchId = Number(settings.defaultBranchId);
    if (!branchId) throw new PermanentError("Default KiotViet branch is not configured");

    let customerId: number | undefined;
    if (settings.syncCustomers !== false && order.customer) {
      await syncShopifyCustomer(order.customer);
      const customer = await client.query<{ kiotviet_customer_id: string }>("SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id=$1", [String(order.customer.id)]);
      customerId = customer.rows[0]?.kiotviet_customer_id ? Number(customer.rows[0].kiotviet_customer_id) : undefined;
    }

    const details = [];
    for (const line of order.line_items) {
      const sku = normalizeSku(line.sku);
      const maps = await mappingsRepository.findBySku(sku);
      if (maps.length !== 1 || !maps[0].kiotviet_product_id) throw new MappingError(`Missing or ambiguous mapping for SKU ${sku || "(empty)"}`);
      details.push({ productId: Number(maps[0].kiotviet_product_id), productCode: line.sku, productName: line.name, quantity: line.quantity, price: Number(line.price), discount: 0 });
    }

    const created = await createKiotVietOrder({
      branchId,
      customerId,
      description: `Shopify ${order.name} (${order.id})`,
      discount: 0,
      method: "Transfer",
      totalPayment: order.financial_status === "paid" ? Number(order.total_price) : 0,
      makeInvoice: false,
      orderDetails: details,
    });

    await client.query("INSERT INTO order_mappings(shopify_order_id,shopify_order_number,kiotviet_order_id,kiotviet_order_code,status,financial_status,fulfillment_status,sync_status,last_sync_at) VALUES($1,$2,$3,$4,'created',$5,$6,'synced',now())", [orderId, order.name, created.id, created.code, order.financial_status, order.fulfillment_status ?? null]);
  });
}

export async function cancelShopifyOrder(order: ShopifyOrderWebhook) {
  await transaction(async (client) => {
    const orderId = String(order.id);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shopify-order:${orderId}`]);
    const result = await client.query<{ kiotviet_order_id: string; status: string | null }>("SELECT kiotviet_order_id,status FROM order_mappings WHERE shopify_order_id=$1", [orderId]);
    if (!result.rows[0]?.kiotviet_order_id) throw new MappingError(`Order ${order.id} is not mapped`);
    if (result.rows[0].status !== "cancelled") await cancelKiotVietOrder(Number(result.rows[0].kiotviet_order_id));
    await client.query("UPDATE order_mappings SET status='cancelled',sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1", [orderId]);
  });
}
