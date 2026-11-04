import { randomUUID } from "node:crypto";
import type {
  ShopifyOrderLineItem,
  ShopifyOrderWebhook,
} from "@/types/shopify";
import {
  ApiError,
  AppError,
  AuthenticationError,
  ConflictError,
  isManualReviewError,
  MappingError,
  RateLimitError,
  RetryableError,
  ValidationError,
} from "@/lib/errors";
import { normalizeSku } from "./mappings";
import {
  createKiotVietOrder,
  cancelKiotVietOrder,
  findKiotVietOrderByShopifyReference,
  updateKiotVietOrderCustomer,
  type KiotVietOrderInput,
} from "@/lib/kiotviet/orders";
import { query, transaction } from "@/lib/db/client";
import { syncShopifyCustomer } from "./customer-sync";
import {
  cancelShopifyOrderById,
  fulfillShopifyOrderById,
} from "@/lib/shopify/orders";
import {
  resolveDefaultBranchId,
  type OrderSettings,
} from "./default-branch";
import { ensureProductMapping } from "./ensure-product-mapping";
import { log } from "@/lib/logger";
import {
  computeOrderAmounts,
  partitionOrderLines,
  type ExcludedFeeLine,
  type OrderAmounts,
} from "./order-line-items";

/*
 * order_mappings.status while creating a KiotViet order from a Shopify order:
 *   pending_create  claimed by one job; validating and mapping, no create request sent
 *   creating        the create request is in flight or its outcome is unknown
 *   create_failed   definitely not created (failed before sending, or KiotViet rejected it)
 *   created         KiotViet order exists (kiotviet_order_id is set); later: cancelled/completed
 * The claim is a row state, not an open transaction, so no PostgreSQL
 * transaction is held during KiotViet/Shopify HTTP calls. A `creating` row is
 * never re-sent blindly: it is verified against KiotViet first and goes to
 * manual review when the outcome stays unknown.
 */
export const ORDER_RECOVERY_WINDOW_MS = 5 * 60_000;
/** pending_create never sent a request, so a claim older than this is safe to take over. */
export const ORDER_CLAIM_LEASE_MS = 15 * 60_000;
export function isOrderRecoveryWindowOpen(
  createdAt: string | Date,
  now = new Date(),
) {
  return (
    now.getTime() - new Date(createdAt).getTime() < ORDER_RECOVERY_WINDOW_MS
  );
}
function isClaimLeaseActive(claimedAt: string | Date, now = new Date()) {
  return now.getTime() - new Date(claimedAt).getTime() < ORDER_CLAIM_LEASE_MS;
}

export interface OrderSyncContext {
  jobType?: string;
  eventId?: string;
  jobId?: string;
}
export type OrderSyncResult =
  | { action: "created" | "recovered" | "updated"; kiotVietOrderId: string }
  | { action: "skipped"; reason: string };

interface OrderMappingRow {
  kiotviet_order_id: string | null;
  status: string | null;
  created_at: string | Date;
  claimed_at: string | Date | null;
}
interface ValidatedOrderLine {
  line: ShopifyOrderLineItem;
  sku: string;
  quantity: number;
  price: number;
}

export function assertShopifyOrderPayload(
  order: unknown,
): asserts order is ShopifyOrderWebhook {
  if (!order || typeof order !== "object")
    throw new ValidationError("Shopify order webhook payload is missing");
  const value = order as Partial<ShopifyOrderWebhook>;
  if (value.id === null || value.id === undefined || !String(value.id).trim())
    throw new ValidationError("Shopify order webhook payload has no order ID");
  if (!Array.isArray(value.line_items))
    throw new ValidationError(
      `Shopify order ${value.id} webhook payload has no line_items array`,
      { shopifyOrderId: String(value.id) },
    );
}

function orderLabel(order: ShopifyOrderWebhook) {
  return order.name
    ? `Shopify order ${order.name} (${order.id})`
    : `Shopify order ${order.id}`;
}

export interface PreparedOrder {
  lines: ValidatedOrderLine[];
  /** Processing-fee lines left out of the KiotViet order and its payment. */
  fees: ExcludedFeeLine[];
  amounts: OrderAmounts;
}

/**
 * Removes recognized processing-fee lines, then requires every remaining
 * purchased line to have a SKU, so an incomplete KiotViet order is never
 * created. Shared by order sync and scripts/recover-shopify-order-sync.ts.
 */
export function prepareOrderForKiotViet(
  order: ShopifyOrderWebhook,
  settings: OrderSettings = {},
): PreparedOrder {
  const shopifyOrderId = String(order.id);
  if (!order.line_items.length)
    throw new ValidationError(`${orderLabel(order)} has no line items`, {
      shopifyOrderId,
    });
  const { purchased, fees } = partitionOrderLines(order, settings);
  const lines = purchased.map(({ line, index }) => {
    const lineName = line?.name ?? line?.title ?? null;
    const lineLabel = `line item ${line?.id ?? `#${index + 1}`}${lineName ? ` "${lineName}"` : ""}`;
    const details = {
      shopifyOrderId,
      shopifyOrderName: order.name ?? null,
      lineItemId: line?.id == null ? null : String(line.id),
      lineItemName: lineName,
    };
    const sku = normalizeSku(line?.sku);
    if (!sku)
      throw new MappingError(
        `${orderLabel(order)} ${lineLabel} has ${line?.sku == null ? "no SKU" : "an empty SKU"} and cannot be mapped to a KiotViet product; manual review required`,
        { ...details, sku: line?.sku ?? null, mappingStatus: "missing_sku" },
      );
    const quantity = Number(line.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      throw new ValidationError(
        `${orderLabel(order)} ${lineLabel} has an invalid quantity`,
        { ...details, sku },
      );
    const price = Number(line.price);
    if (!Number.isFinite(price) || price < 0)
      throw new ValidationError(
        `${orderLabel(order)} ${lineLabel} has an invalid price`,
        { ...details, sku },
      );
    return { line, sku, quantity, price };
  });
  return {
    lines,
    fees,
    amounts: computeOrderAmounts(order, lines.map(({ line }) => line), fees),
  };
}

export function validateOrderLineItems(
  order: ShopifyOrderWebhook,
  settings: OrderSettings = {},
): ValidatedOrderLine[] {
  return prepareOrderForKiotViet(order, settings).lines;
}

function feeLogContext(prepared: PreparedOrder) {
  return {
    shopifyTotal: prepared.amounts.shopifyTotal,
    excludedFeeTotal: prepared.amounts.excludedFeeTotal,
    adjustedKiotVietTotal: prepared.amounts.adjustedTotal,
    expectedAdjustedTotal: prepared.amounts.expectedAdjustedTotal,
    excludedFeeLines: prepared.fees.map((fee) => ({
      lineItemId: String(fee.line.id),
      title: fee.line.title ?? fee.line.name ?? null,
      reason: fee.reason,
      amount: fee.chargedCents / 100,
    })),
  };
}

async function buildOrderDetails(
  order: ShopifyOrderWebhook,
  lines: ValidatedOrderLine[],
  jobId?: string,
): Promise<KiotVietOrderInput["orderDetails"]> {
  const details: KiotVietOrderInput["orderDetails"] = [];
  for (const { line, sku, quantity, price } of lines) {
    const lineDetails = {
      shopifyOrderId: String(order.id),
      lineItemId: String(line.id),
      sku,
    };
    let mapping;
    try {
      mapping = await ensureProductMapping(sku, jobId);
    } catch (error) {
      if (error instanceof MappingError || error instanceof ConflictError)
        throw new MappingError(
          `${orderLabel(order)} line item ${line.id} (SKU ${sku}): ${error.message}`,
          { mappingStatus: "mapping_error", ...error.details, ...lineDetails },
        );
      throw error;
    }
    const productId = Number(mapping.kiotviet_product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0)
      throw new MappingError(
        `${orderLabel(order)} line item ${line.id} (SKU ${sku}) has no KiotViet product ID`,
        { ...lineDetails, mappingStatus: "incomplete_mapping" },
      );
    details.push({
      productId,
      productCode: String(line.sku),
      productName: line.name ?? line.title ?? sku,
      quantity,
      price,
      discount: 0,
    });
  }
  return details;
}

/**
 * Guest checkouts (customer=null) and disabled customer sync create the KiotViet
 * order without a customer, which KiotViet records as a walk-in customer
 * ("Khách lẻ"). Customer IDs are never invented.
 */
async function resolveOrderCustomerId(
  order: ShopifyOrderWebhook,
  settings: OrderSettings,
  branchId?: number,
): Promise<number | undefined> {
  if (settings.syncCustomers === false || !order.customer) return undefined;
  const shopifyCustomerId = Number(order.customer.id);
  if (!Number.isSafeInteger(shopifyCustomerId) || shopifyCustomerId <= 0) {
    await log("warn", "Shopify order customer has no ID; using KiotViet walk-in customer", {
      action: "order_customer_missing_id",
      provider: "shopify",
      entityType: "order",
      entityId: String(order.id),
    });
    return undefined;
  }
  await syncShopifyCustomer({ ...order.customer, id: shopifyCustomerId }, branchId);
  const rows = await query<{ kiotviet_customer_id: string | null }>(
    "SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id=$1",
    [String(shopifyCustomerId)],
  );
  const customerId = Number(rows[0]?.kiotviet_customer_id);
  return Number.isSafeInteger(customerId) && customerId > 0
    ? customerId
    : undefined;
}

/** KiotViet answered and refused the request, so nothing was created. */
function isDefiniteRejection(error: unknown) {
  return (
    error instanceof ApiError ||
    error instanceof AuthenticationError ||
    error instanceof RateLimitError ||
    error instanceof ValidationError
  );
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function reportOrderSyncFailure(
  order: Partial<ShopifyOrderWebhook> | undefined,
  context: OrderSyncContext,
  stage: string,
  error: unknown,
) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const details =
    (failure as { details?: Record<string, unknown> }).details ?? {};
  const shopifyOrderId = order?.id == null ? null : String(order.id);
  await log(isManualReviewError(failure) ? "warn" : "error", "Shopify order sync failed", {
    action: "order_sync_failed",
    provider: "kiotviet",
    entityType: "order",
    entityId: shopifyOrderId,
    jobId: context.jobId,
    jobType: context.jobType,
    eventId: context.eventId,
    shopifyOrderId,
    shopifyOrderName: order?.name ?? null,
    errorClass: failure.name,
    errorCode: failure instanceof AppError ? failure.code : null,
    failureStage: stage,
    retryable: !isManualReviewError(failure),
    sku: details.sku ?? null,
    lineItemId: details.lineItemId ?? null,
    mappingStatus: details.mappingStatus ?? null,
    error: errorText(failure),
  });
}

/** Makes a failure that happened before claiming visible on the order mapping. */
async function recordUnclaimedFailure(
  order: ShopifyOrderWebhook,
  stage: string,
  error: unknown,
) {
  await query(
    `INSERT INTO order_mappings(shopify_order_id,shopify_order_number,status,financial_status,fulfillment_status,sync_status,last_error,failure_stage)
    VALUES($1,$2,'create_failed',$3,$4,$5,$6,$7)
    ON CONFLICT(shopify_order_id) DO UPDATE SET status='create_failed',sync_status=EXCLUDED.sync_status,
      last_error=EXCLUDED.last_error,failure_stage=EXCLUDED.failure_stage,updated_at=now()
    WHERE order_mappings.kiotviet_order_id IS NULL
      AND order_mappings.status IS DISTINCT FROM 'creating'
      AND order_mappings.status IS DISTINCT FROM 'pending_create'`,
    [
      String(order.id),
      order.name ?? null,
      order.financial_status ?? null,
      order.fulfillment_status ?? null,
      isManualReviewError(error) ? "manual_review" : "failed",
      errorText(error),
      stage,
    ],
  );
}

export async function syncShopifyOrder(
  order: ShopifyOrderWebhook,
  context: OrderSyncContext = {},
): Promise<OrderSyncResult> {
  const progress = { stage: "validate_payload" };
  try {
    assertShopifyOrderPayload(order);
    return await runShopifyOrderSync(order, context, progress);
  } catch (error) {
    await reportOrderSyncFailure(
      order && typeof order === "object" ? order : undefined,
      context,
      progress.stage,
      error,
    );
    throw error;
  }
}

async function runShopifyOrderSync(
  order: ShopifyOrderWebhook,
  context: OrderSyncContext,
  progress: { stage: string },
): Promise<OrderSyncResult> {
  const orderId = String(order.id);
  progress.stage = "claim";
  // Short transaction: the advisory lock serializes the decision, no HTTP inside.
  const decision = await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`shopify-order:${orderId}`],
    );
    const settingsResult = await client.query<{ value: OrderSettings }>(
      "SELECT value FROM system_settings WHERE key='orders'",
    );
    const settings = settingsResult.rows[0]?.value ?? {};
    const existing = await client.query<OrderMappingRow>(
      "SELECT kiotviet_order_id,status,created_at,claimed_at FROM order_mappings WHERE shopify_order_id=$1",
      [orderId],
    );
    const mapping = existing.rows[0];
    if (mapping?.kiotviet_order_id)
      return { kind: "update", settings, mapping } as const;
    if (mapping?.status === "creating")
      return { kind: "verify", mapping } as const;
    if (
      mapping?.status === "pending_create" &&
      isClaimLeaseActive(mapping.claimed_at ?? mapping.created_at)
    )
      return { kind: "busy" } as const;
    if (settings.autoCreate === false)
      return { kind: "skip", reason: "auto_create_disabled" } as const;
    if (settings.paidOnly !== false && order.financial_status !== "paid")
      return { kind: "skip", reason: "awaiting_payment" } as const;
    if (order.cancelled_at)
      return { kind: "skip", reason: "shopify_order_cancelled" } as const;
    let prepared: PreparedOrder;
    try {
      prepared = prepareOrderForKiotViet(order, settings);
    } catch (error) {
      return { kind: "invalid", error } as const;
    }
    // Never create an empty KiotViet order when only processing fees remain.
    if (!prepared.lines.length)
      return { kind: "skip", reason: "fee_only_order", prepared } as const;
    const token = randomUUID();
    if (mapping)
      await client.query(
        "UPDATE order_mappings SET status='pending_create',claim_token=$2,claimed_at=now(),financial_status=$3,fulfillment_status=$4,sync_status='pending',last_error=NULL,failure_stage=NULL,updated_at=now() WHERE shopify_order_id=$1",
        [orderId, token, order.financial_status ?? null, order.fulfillment_status ?? null],
      );
    else
      await client.query(
        "INSERT INTO order_mappings(shopify_order_id,shopify_order_number,status,financial_status,fulfillment_status,sync_status,claim_token,claimed_at) VALUES($1,$2,'pending_create',$3,$4,'pending',$5,now())",
        [orderId, order.name ?? null, order.financial_status ?? null, order.fulfillment_status ?? null, token],
      );
    return { kind: "create", settings, prepared, token } as const;
  });

  switch (decision.kind) {
    case "busy":
      throw new RetryableError(
        `${orderLabel(order)} is already being created by another job`,
      );
    case "skip":
      await log("info", "Shopify order not sent to KiotViet", {
        action: "order_sync_skipped",
        provider: "kiotviet",
        entityType: "order",
        entityId: orderId,
        reason: decision.reason,
        ...("prepared" in decision && decision.prepared ? feeLogContext(decision.prepared) : {}),
        jobId: context.jobId,
        jobType: context.jobType,
        eventId: context.eventId,
      });
      return { action: "skipped", reason: decision.reason };
    case "invalid":
      progress.stage = "validate_line_items";
      await recordUnclaimedFailure(order, progress.stage, decision.error).catch(() => undefined);
      throw decision.error;
    case "update":
      return updateMappedOrder(order, decision.settings, decision.mapping, progress);
    case "verify":
      return verifyUncertainOrder(order, decision.mapping, progress);
    case "create":
      return createMappedOrder(order, decision.settings, decision.prepared, decision.token, context, progress);
  }
}

async function updateMappedOrder(
  order: ShopifyOrderWebhook,
  settings: OrderSettings,
  mapping: OrderMappingRow,
  progress: { stage: string },
): Promise<OrderSyncResult> {
  const orderId = String(order.id);
  const kiotVietOrderId = String(mapping.kiotviet_order_id);
  if ((mapping.status ?? "created") === "created" && order.customer) {
    progress.stage = "update_customer";
    const customerId = await resolveOrderCustomerId(order, settings);
    if (customerId)
      await updateKiotVietOrderCustomer(Number(kiotVietOrderId), customerId);
  }
  progress.stage = "record_status";
  // Status is left alone so a concurrent cancellation is never overwritten.
  await query(
    "UPDATE order_mappings SET status=COALESCE(status,'created'),financial_status=$2,fulfillment_status=$3,sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1",
    [orderId, order.financial_status ?? null, order.fulfillment_status ?? null],
  );
  return { action: "updated", kiotVietOrderId };
}

async function verifyUncertainOrder(
  order: ShopifyOrderWebhook,
  mapping: OrderMappingRow,
  progress: { stage: string },
): Promise<OrderSyncResult> {
  const orderId = String(order.id);
  progress.stage = "verify_existing_order";
  const recovered = await findKiotVietOrderByShopifyReference(orderId);
  if (recovered) {
    await query(
      "UPDATE order_mappings SET kiotviet_order_id=$2,kiotviet_order_code=$3,status='created',financial_status=$4,fulfillment_status=$5,sync_status='synced',claim_token=NULL,last_error=NULL,failure_stage=NULL,last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1 AND status='creating' AND kiotviet_order_id IS NULL",
      [orderId, recovered.id, recovered.code, order.financial_status ?? null, order.fulfillment_status ?? null],
    );
    await log("info", "Existing KiotViet order linked to Shopify order", {
      action: "order_recovered",
      provider: "kiotviet",
      entityType: "order",
      entityId: orderId,
      kiotVietOrderId: recovered.id,
    });
    return { action: "recovered", kiotVietOrderId: String(recovered.id) };
  }
  if (isOrderRecoveryWindowOpen(mapping.claimed_at ?? mapping.created_at))
    throw new RetryableError(
      `Order ${order.id} is still inside the recovery window`,
    );
  const error = new ConflictError(
    `${orderLabel(order)}: a KiotViet create request may have been sent but no KiotViet order references it; verify in KiotViet before recreating (see docs/order-inventory-sync.md)`,
    { shopifyOrderId: orderId, mappingStatus: "creation_outcome_unknown" },
  );
  await query(
    "UPDATE order_mappings SET sync_status='manual_review',failure_stage=$2,last_error=$3,updated_at=now() WHERE shopify_order_id=$1 AND status='creating'",
    [orderId, progress.stage, errorText(error)],
  );
  throw error;
}

async function createMappedOrder(
  order: ShopifyOrderWebhook,
  settings: OrderSettings,
  prepared: PreparedOrder,
  token: string,
  context: OrderSyncContext,
  progress: { stage: string },
): Promise<OrderSyncResult> {
  const orderId = String(order.id);
  let input: KiotVietOrderInput;
  try {
    progress.stage = "resolve_branch";
    const branchId = await resolveDefaultBranchId(undefined, settings);
    progress.stage = "sync_customer";
    const customerId = await resolveOrderCustomerId(order, settings, branchId);
    progress.stage = "product_mapping";
    const orderDetails = await buildOrderDetails(order, prepared.lines, context.jobId);
    input = {
      branchId,
      customer: customerId ? { id: customerId } : undefined,
      description: `Shopify ${order.name} (${order.id})`,
      discount: 0,
      method: "Transfer",
      // Processing fees are not KiotViet products, so their charged amount is
      // excluded from the payment as well (see lib/sync/order-line-items.ts).
      totalPayment:
        order.financial_status === "paid" ? prepared.amounts.adjustedTotal : 0,
      makeInvoice: false,
      orderDetails,
    };
  } catch (error) {
    // Nothing was sent to KiotViet yet, so the order can be claimed again.
    await query(
      "UPDATE order_mappings SET status='create_failed',sync_status=$3,claim_token=NULL,last_error=$4,failure_stage=$5,updated_at=now() WHERE shopify_order_id=$1 AND status='pending_create' AND claim_token=$2",
      [orderId, token, isManualReviewError(error) ? "manual_review" : "failed", errorText(error), progress.stage],
    ).catch(() => undefined);
    throw error;
  }

  if (prepared.fees.length || !prepared.amounts.consistent)
    await log(prepared.amounts.consistent ? "info" : "warn", "Shopify order amounts adjusted for KiotViet", {
      action: prepared.amounts.consistent ? "order_fees_excluded" : "order_amount_mismatch",
      provider: "kiotviet",
      entityType: "order",
      entityId: orderId,
      kiotVietLineTotal: input.orderDetails.reduce((sum, detail) => sum + Math.round(detail.price * 100) * detail.quantity, 0) / 100,
      totalPayment: input.totalPayment,
      ...feeLogContext(prepared),
      jobId: context.jobId,
      jobType: context.jobType,
      eventId: context.eventId,
    });

  progress.stage = "mark_creating";
  const marked = await query(
    "UPDATE order_mappings SET status='creating',claimed_at=now(),updated_at=now() WHERE shopify_order_id=$1 AND status='pending_create' AND claim_token=$2 RETURNING shopify_order_id",
    [orderId, token],
  );
  if (!marked.length)
    throw new RetryableError(
      `${orderLabel(order)} creation claim was taken over by another job`,
    );

  progress.stage = "create_kiotviet_order";
  let created: { id: number; code: string };
  try {
    created = await createKiotVietOrder(input);
  } catch (error) {
    // A rejection means nothing was created. Anything else (timeout, 5xx, crash)
    // leaves the row in `creating` so the next attempt verifies before resending.
    const rejected = isDefiniteRejection(error);
    await query(
      rejected
        ? "UPDATE order_mappings SET status='create_failed',sync_status='failed',claim_token=NULL,last_error=$3,failure_stage=$4,updated_at=now() WHERE shopify_order_id=$1 AND status='creating' AND claim_token=$2"
        : "UPDATE order_mappings SET sync_status='uncertain',last_error=$3,failure_stage=$4,updated_at=now() WHERE shopify_order_id=$1 AND status='creating' AND claim_token=$2",
      [orderId, token, errorText(error), progress.stage],
    ).catch(() => undefined);
    throw error;
  }

  progress.stage = "record_mapping";
  const recorded = await query(
    "UPDATE order_mappings SET kiotviet_order_id=$3,kiotviet_order_code=$4,status='created',financial_status=$5,fulfillment_status=$6,sync_status='synced',claim_token=NULL,last_error=NULL,failure_stage=NULL,last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1 AND status='creating' AND claim_token=$2 RETURNING shopify_order_id",
    [orderId, token, created.id, created.code, order.financial_status ?? null, order.fulfillment_status ?? null],
  );
  if (!recorded.length)
    throw new ConflictError(
      `KiotViet order ${created.code} was created for ${orderLabel(order)} but its mapping changed concurrently; manual review required`,
      { shopifyOrderId: orderId, mappingStatus: "mapping_changed" },
    );
  await log("info", "KiotViet order created from Shopify order", {
    action: "order_created",
    provider: "kiotviet",
    entityType: "order",
    entityId: orderId,
    kiotVietOrderId: created.id,
    jobId: context.jobId,
    jobType: context.jobType,
    eventId: context.eventId,
  });
  return { action: "created", kiotVietOrderId: String(created.id) };
}

export async function cancelShopifyOrder(order: ShopifyOrderWebhook) {
  const orderId = String(order.id);
  // No transaction around the KiotViet call: cancelKiotVietOrder is a no-op on an
  // already cancelled order, so concurrent cancellations stay safe.
  const [mapping] = await query<{
    kiotviet_order_id: string | null;
    status: string | null;
  }>(
    "SELECT kiotviet_order_id,status FROM order_mappings WHERE shopify_order_id=$1",
    [orderId],
  );
  if (!mapping?.kiotviet_order_id) {
    if (mapping?.status === "pending_create" || mapping?.status === "creating")
      throw new RetryableError(
        `Order ${order.id} is still being created in KiotViet`,
      );
    throw new MappingError(`Order ${order.id} is not mapped`);
  }
  if (mapping.status !== "cancelled")
    await cancelKiotVietOrder(Number(mapping.kiotviet_order_id));
  await query(
    "UPDATE order_mappings SET status='cancelled',sync_status='synced',last_sync_at=now(),updated_at=now() WHERE shopify_order_id=$1",
    [orderId],
  );
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
