import { createHash, randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import { ApiError, AuthenticationError, MappingError, RateLimitError, RetryableError, ValidationError } from "@/lib/errors";
import { getKiotVietInvoice, getKiotVietReturn, getKiotVietReturns } from "@/lib/kiotviet/returns";
import type { KiotVietReturn } from "@/lib/kiotviet/types";
import { log } from "@/lib/logger";
import { enqueueJob } from "@/lib/queue/queues";
import {
  createShopifyReturnRefund,
  getShopifyRefundableLines,
  getShopifyRefundTransactions,
  InsufficientRefundableAmountError,
  kiotVietReturnRefundNote,
  ShopifyRefundRejectedError,
  type ShopifyExistingRefund,
} from "@/lib/shopify/orders";
import { normalizeSku } from "./mappings";

/*
 * KiotViet return → Shopify financial refund, one durable row per return in refund_mappings:
 *   processing          claimed by one worker; validating; refundCreate NOT sent
 *   sending             refundCreate sent, or its outcome is unknown: NEVER sent again; only
 *                       reconciled against Shopify's refunds (our note identifies ours)
 *   financial_refunded  Shopify refund id recorded (created by us or linked)
 *   needs_review        evidence insufficient or outcome unknown; no automatic money movement
 *   failed              definitely not sent (validation, or Shopify rejected it)
 * PostgreSQL transactions are short (claim / state changes); no HTTP call runs inside one.
 */
export const RETURN_CLAIM_LEASE_MS = 15 * 60_000;
/** After this long without the refund being visible in Shopify, an unknown outcome needs review. */
export const RETURN_SEND_VERIFY_MS = 10 * 60_000;

/** Same key format as earlier versions, so a request they sent is recognized by Shopify too. */
export function returnIdempotencyKey(returnId: number) {
  return createHash("sha256").update(`kiotviet-financial-return:${returnId}`).digest("hex");
}

/**
 * Shopify lines for each returned SKU. Repeated SKUs on either side are aggregated, then spread
 * deterministically over Shopify lines (by id) within each line's refundable quantity.
 */
export function matchReturnLines(returned: KiotVietReturn["returnDetails"], shopify: Array<{ id: string; sku?: string; refundableQuantity: number }>) {
  const wanted = new Map<string, number>();
  for (const line of returned) {
    const sku = normalizeSku(line.productCode);
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new ValidationError(`Invalid return quantity for SKU ${sku || "(empty)"}`);
    wanted.set(sku, (wanted.get(sku) ?? 0) + line.quantity);
  }
  const lines: Array<{ lineItemId: string; quantity: number }> = [];
  for (const [sku, quantity] of wanted) {
    const candidates = shopify.filter((line) => sku && normalizeSku(line.sku ?? "") === sku).sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) throw new MappingError(`Missing Shopify line for returned SKU ${sku || "(empty)"}`);
    const refundable = candidates.reduce((sum, line) => sum + Math.max(0, line.refundableQuantity), 0);
    if (quantity > refundable) throw new ValidationError(`Return quantity for SKU ${sku} exceeds Shopify refundable quantity (${quantity} > ${refundable})`);
    let remaining = quantity;
    for (const line of candidates) {
      const take = Math.min(remaining, Math.max(0, line.refundableQuantity));
      if (take > 0) lines.push({ lineItemId: line.id, quantity: take });
      remaining -= take;
      if (!remaining) break;
    }
  }
  return lines;
}

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);

/**
 * What Shopify's existing refunds say about this return. Only a refund carrying this app's note
 * for this return code is evidence that it was refunded (e.g. a crash after refundCreate).
 * A matching SKU/quantity is NOT evidence of payment: any other refund that could be this return
 * (touches a returned SKU, or a money-only refund made on/after the return) needs a person.
 */
export function classifyExistingRefunds(
  returned: Pick<KiotVietReturn, "code" | "returnDate" | "returnDetails">,
  refunds: ShopifyExistingRefund[],
  linkedElsewhere: Set<string>,
) {
  const note = kiotVietReturnRefundNote(returned.code);
  const ours = refunds.filter((refund) => (refund.note ?? "").trim() === note);
  const returnedSkus = new Set((returned.returnDetails ?? []).map((line) => normalizeSku(line.productCode)));
  const returnTime = Date.parse(returned.returnDate);
  const suspicious = refunds.filter((refund) => {
    if (ours.includes(refund) || linkedElsewhere.has(refund.id)) return false;
    const items = refund.refundLineItems?.nodes ?? [];
    if (items.some((item) => returnedSkus.has(normalizeSku(item.lineItem.sku ?? "")))) return true;
    const moneyOnly = !items.length && cents(refund.totalRefundedSet?.shopMoney.amount) > 0;
    return moneyOnly && (!Number.isFinite(returnTime) || !refund.createdAt || Date.parse(refund.createdAt) >= returnTime - 86_400_000);
  });
  return { ours, suspicious };
}

interface RefundRow {
  status: string | null;
  claim_token: string | null;
  claimed_at: string | Date | null;
  sent_at: string | Date | null;
  financial_refund_id: string | null;
  amount: string | null;
  attempt_count: number;
}

export type ReturnSyncResult =
  | { created: false; reason: string; refundId?: string }
  | { created: true; refundId: string; returnCode: string; amount: number };

function stepLog(level: "info" | "warn" | "error", returnId: number, action: string, details: Record<string, unknown> = {}) {
  return log(level, `KiotViet return refund: ${action}`, { action: `return_refund_${action}`, provider: "shopify", entityType: "refund", entityId: String(returnId), ...details });
}

async function setState(returnId: number, token: string, status: string, extra: { lastError?: string | null; stage?: string | null; refundId?: string | null; response?: unknown; source?: string } = {}) {
  await query(
    `UPDATE refund_mappings SET status=$3,claim_token=NULL,last_error=$4,failure_stage=$5,
      financial_refund_id=COALESCE($6,financial_refund_id),shopify_refund_id=COALESCE($6,shopify_refund_id),
      response=COALESCE($7::jsonb,response),source=COALESCE($8,source),updated_at=now()
    WHERE kiotviet_return_id=$1 AND claim_token=$2`,
    [returnId, token, status, extra.lastError?.slice(0, 2000) ?? null, extra.stage ?? null, extra.refundId ?? null,
      extra.response === undefined ? null : JSON.stringify(extra.response), extra.source ?? null],
  );
}

export async function syncKiotVietReturn(returnId: number): Promise<ReturnSyncResult> {
  // Read-only lookups first, outside any transaction.
  const returned = await getKiotVietReturn(returnId);
  const statusText = String(returned.statusValue ?? "").toLocaleLowerCase("vi");
  if (returned.status !== 1 && !statusText.includes("hoàn thành")) return { created: false, reason: "return_not_completed" };
  if (!returned.invoiceId) throw new MappingError(`KiotViet return ${returned.code} has no invoice`);
  const invoice = await getKiotVietInvoice(returned.invoiceId);
  if (!invoice.orderCode) throw new MappingError(`KiotViet invoice ${invoice.code} has no source order code`);
  const mapped = await query<{ shopify_order_id: string; kiotviet_order_id: string }>(
    "SELECT shopify_order_id,kiotviet_order_id FROM order_mappings WHERE kiotviet_order_code=$1", [invoice.orderCode]);
  if (mapped.length !== 1) throw new MappingError(`KiotViet order ${invoice.orderCode} is not uniquely mapped to Shopify`);
  const { shopify_order_id: shopifyOrderId, kiotviet_order_id: kiotVietOrderId } = mapped[0];

  // Short claim transaction (advisory lock + row lock); nothing external happens inside it.
  const token = randomUUID();
  const key = returnIdempotencyKey(returned.id);
  const claim = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`kiotviet-return:${returnId}`]);
    const existing = (await client.query<RefundRow>(
      "SELECT status,claim_token,claimed_at,sent_at,financial_refund_id,amount::text,attempt_count FROM refund_mappings WHERE kiotviet_return_id=$1 FOR UPDATE",
      [returnId])).rows[0];
    if (existing?.financial_refund_id || existing?.status === "financial_refunded") return { kind: "done" as const, refundId: existing.financial_refund_id ?? undefined };
    if (existing?.status === "needs_review") return { kind: "review" as const };
    // A live claim (validating, or with refundCreate in flight) is never taken over.
    if ((existing?.status === "processing" || (existing?.status === "sending" && existing.claim_token)) &&
        existing.claimed_at && Date.now() - new Date(existing.claimed_at).getTime() < RETURN_CLAIM_LEASE_MS)
      return { kind: "busy" as const };
    const reconcileOnly = existing?.status === "sending"; // a refund may already exist: never send again
    const result = await client.query(
      `INSERT INTO refund_mappings(shopify_order_id,kiotviet_order_id,kiotviet_return_id,kiotviet_return_code,kiotviet_invoice_id,status,
        idempotency_key,claim_token,claimed_at,attempt_count,payload)
      VALUES($1,$2,$3,$4,$5,'processing',$6,$7,now(),1,$8)
      ON CONFLICT(kiotviet_return_id) WHERE kiotviet_return_id IS NOT NULL DO UPDATE SET
        status=CASE WHEN refund_mappings.status='sending' THEN 'sending' ELSE 'processing' END,
        claim_token=EXCLUDED.claim_token,claimed_at=now(),attempt_count=refund_mappings.attempt_count+1,
        idempotency_key=COALESCE(refund_mappings.idempotency_key,EXCLUDED.idempotency_key),payload=EXCLUDED.payload,updated_at=now()
      WHERE refund_mappings.financial_refund_id IS NULL AND refund_mappings.status IS DISTINCT FROM 'financial_refunded'
        AND refund_mappings.status IS DISTINCT FROM 'needs_review'
      RETURNING kiotviet_return_id`,
      [shopifyOrderId, kiotVietOrderId, returned.id, returned.code, returned.invoiceId, key, token, JSON.stringify(returned)],
    );
    if (!result.rows.length) return { kind: "busy" as const };
    return { kind: reconcileOnly ? "reconcile" as const : "claimed" as const, sentAt: existing?.sent_at ?? null };
  });
  if (claim.kind === "done") return { created: false, reason: "already_financially_refunded", ...(claim.refundId ? { refundId: claim.refundId } : {}) };
  if (claim.kind === "review") return { created: false, reason: "needs_review" };
  if (claim.kind === "busy") throw new RetryableError(`KiotViet return ${returned.code} is being processed by another worker`);
  await stepLog("info", returnId, "claimed", { returnCode: returned.code, shopifyOrderId, reconcileOnly: claim.kind === "reconcile" });

  try {
    return await processClaimedReturn(returned, token, key, shopifyOrderId, claim.kind === "reconcile", claim.sentAt);
  } catch (error) {
    // Release the claim. 'processing' sent nothing → failed (retryable); 'sending' keeps its state
    // (a refund may exist) and is only reconciled later.
    await query(
      `UPDATE refund_mappings SET status=CASE WHEN status='processing' THEN 'failed' ELSE status END,claim_token=NULL,last_error=$3,
        failure_stage=CASE WHEN status='processing' THEN COALESCE(failure_stage,'validation') ELSE failure_stage END,updated_at=now()
      WHERE kiotviet_return_id=$1 AND claim_token=$2`,
      [returnId, token, (error instanceof Error ? error.message : String(error)).slice(0, 2000)],
    ).catch(() => undefined);
    throw error;
  }
}

async function processClaimedReturn(
  returned: KiotVietReturn, token: string, key: string, shopifyOrderId: string, reconcileOnly: boolean, sentAt: string | Date | null,
): Promise<ReturnSyncResult> {
  const returnId = returned.id;
  const order = await getShopifyRefundableLines(shopifyOrderId);
  const linked = await query<{ financial_refund_id: string }>(
    "SELECT financial_refund_id FROM refund_mappings WHERE shopify_order_id=$1 AND financial_refund_id IS NOT NULL AND kiotviet_return_id IS DISTINCT FROM $2",
    [shopifyOrderId, returnId]);
  const { ours, suspicious } = classifyExistingRefunds(returned, order.refunds ?? [], new Set(linked.map((row) => row.financial_refund_id)));

  if (ours.length > 1) {
    const message = `duplicate_refunds: ${ours.length} Shopify refunds (${ours.map((refund) => refund.id).join(", ")}) carry the note of KiotViet return ${returned.code}`;
    await setState(returnId, token, "needs_review", { lastError: message, stage: "reconcile" });
    await stepLog("error", returnId, "duplicate_detected", { refunds: ours.map((refund) => refund.id) });
    return { created: false, reason: "needs_review" };
  }
  if (ours.length === 1) {
    // Our earlier refundCreate succeeded (e.g. the worker stopped before saving): link, never refund again.
    const refund = ours[0];
    const expected = expectedAmount(returned);
    const amountMatches = expected !== null && cents(refund.totalRefundedSet?.shopMoney.amount) === cents(expected);
    await query("UPDATE refund_mappings SET amount=COALESCE(amount,$3) WHERE kiotviet_return_id=$1 AND claim_token=$2",
      [returnId, token, refund.totalRefundedSet?.shopMoney.amount ?? null]);
    await setState(returnId, token, amountMatches ? "financial_refunded" : "needs_review", {
      refundId: refund.id, source: "recovered", response: refund,
      lastError: amountMatches ? null : `linked Shopify refund ${refund.id} amount ${refund.totalRefundedSet?.shopMoney.amount ?? "?"} differs from KiotViet return ${expected ?? "?"}; no further refund is made`,
      stage: amountMatches ? null : "reconcile",
    });
    await stepLog(amountMatches ? "info" : "warn", returnId, "linked_existing", { refundId: refund.id, amountMatches });
    return { created: false, reason: "linked_existing_refund", refundId: refund.id };
  }
  if (reconcileOnly) {
    // refundCreate was sent (or may have been) and no refund of ours is visible.
    const sent = sentAt ? new Date(sentAt).getTime() : 0;
    if (Date.now() - sent < RETURN_SEND_VERIFY_MS) {
      await query("UPDATE refund_mappings SET claim_token=NULL,updated_at=now() WHERE kiotviet_return_id=$1 AND claim_token=$2", [returnId, token]);
      throw new RetryableError(`Outcome of the Shopify refund for KiotViet return ${returned.code} is not visible yet; never resent`);
    }
    const message = `refund_outcome_unknown: refundCreate for KiotViet return ${returned.code} was sent but no refund with its note exists in Shopify; verify in Shopify before any manual action (never resent automatically)`;
    await setState(returnId, token, "needs_review", { lastError: message, stage: "reconcile" });
    await stepLog("error", returnId, "outcome_unknown", {});
    return { created: false, reason: "needs_review" };
  }
  if (suspicious.length) {
    const message = `existing_refund_unverified: Shopify order already has refund(s) ${suspicious.map((refund) => refund.id).join(", ")} that may cover KiotViet return ${returned.code}; matching SKUs are not proof of payment, so no refund is created automatically`;
    await setState(returnId, token, "needs_review", { lastError: message, stage: "reconcile", response: suspicious });
    await stepLog("warn", returnId, "existing_refund_unverified", { refunds: suspicious.map((refund) => refund.id) });
    return { created: false, reason: "needs_review" };
  }

  const amount = expectedAmount(returned);
  if (amount === null) {
    const message = `no_payment_returned: KiotViet return ${returned.code} records no money paid back to the customer (totalPayment ${returned.totalPayment ?? "missing"}); no Shopify refund is made automatically`;
    await setState(returnId, token, "needs_review", { lastError: message, stage: "validation" });
    return { created: false, reason: "needs_review" };
  }
  const lines = matchReturnLines(returned.returnDetails ?? [], order.lineItems.nodes);
  if (!lines.length) throw new ValidationError(`KiotViet return ${returned.code} contains no return lines`);
  let transactions;
  try {
    transactions = await getShopifyRefundTransactions(shopifyOrderId, amount);
  } catch (error) {
    if (!(error instanceof InsufficientRefundableAmountError)) throw error;
    await setState(returnId, token, "needs_review", { lastError: `insufficient_refundable_payment: ${error.message}`, stage: "validation" });
    return { created: false, reason: "needs_review" };
  }

  // Persist the exact request and switch to 'sending' before Shopify is called.
  const request = { orderId: shopifyOrderId, lines, transactions, amount, returnCode: returned.code, idempotencyKey: key };
  const marked = await query(
    "UPDATE refund_mappings SET status='sending',request=$3,amount=$4,sent_at=now(),updated_at=now() WHERE kiotviet_return_id=$1 AND claim_token=$2 AND status='processing' RETURNING kiotviet_return_id",
    [returnId, token, JSON.stringify(request), amount]);
  if (!marked.length) return { created: false, reason: "claim_lost" };
  await stepLog("info", returnId, "sending", { amount, lines, idempotencyKey: key });

  let refund: { id: string };
  try {
    refund = await createShopifyReturnRefund(shopifyOrderId, lines, transactions, returned.code, key);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const definite = error instanceof ShopifyRefundRejectedError || error instanceof AuthenticationError || error instanceof RateLimitError ||
      (error instanceof ApiError && error.status >= 400 && error.status < 500);
    if (definite) {
      await setState(returnId, token, "failed", { lastError: `shopify_rejected: ${text}`, stage: "shopify_refund" });
      await stepLog("warn", returnId, "rejected", { error: text });
      throw error;
    }
    // Possibly created: stays 'sending' (never resent); the next run reconciles by note.
    await query("UPDATE refund_mappings SET claim_token=NULL,last_error=$3,failure_stage='shopify_refund',updated_at=now() WHERE kiotviet_return_id=$1 AND claim_token=$2",
      [returnId, token, `outcome_unknown: ${text}`.slice(0, 2000)]).catch(() => undefined);
    await stepLog("error", returnId, "outcome_unknown", { error: text });
    throw new RetryableError(`Shopify refund for KiotViet return ${returned.code} has an unknown outcome; it will be reconciled, never resent`);
  }
  // If this write fails, the row stays 'sending' and the next run links the refund by its note.
  await setState(returnId, token, "financial_refunded", { refundId: refund.id, response: refund, source: "created" });
  await stepLog("info", returnId, "created", { refundId: refund.id, amount });
  return { created: true, refundId: refund.id, returnCode: returned.code, amount };
}

/** Money KiotViet actually paid back. A return without a payment back is never refunded automatically. */
function expectedAmount(returned: KiotVietReturn) {
  const paid = Math.abs(Number(returned.totalPayment));
  if (Number.isFinite(paid) && paid > 0) return Math.round(paid * 100) / 100;
  // Older payloads without totalPayment: the return total is the refundable amount.
  if (returned.totalPayment === undefined || returned.totalPayment === null) {
    const total = Math.abs(Number(returned.returnTotal));
    return Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : null;
  }
  return null;
}

/**
 * Scheduler: queues new or changed completed returns, and returns whose refund attempt is stuck
 * (stale 'processing' claim, or an unknown 'sending' outcome to reconcile). Queue job ids include
 * the attempt number, so a finished job never blocks the next attempt and duplicates collapse.
 */
export async function reconcileKiotVietReturns() {
  const cursors = await query<{ value: { lastModifiedFrom?: string } }>("SELECT value FROM system_settings WHERE key='kiotviet_returns_cursor'");
  const stored = cursors[0]?.value?.lastModifiedFrom;
  const start = stored ? new Date(new Date(stored).getTime() - 5 * 60_000) : new Date(Date.now() - 7 * 24 * 60 * 60_000);
  let currentItem = 0, total = 1, latest = stored ?? start.toISOString(), queued = 0;
  while (currentItem < total) {
    const page = await getKiotVietReturns(start.toISOString(), currentItem, 100);
    total = page.total;
    for (const item of page.data) {
      const modified = item.modifiedDate ?? item.returnDate;
      if (modified && new Date(modified) > new Date(latest)) latest = new Date(modified).toISOString();
      const synced = await query("SELECT 1 FROM refund_mappings WHERE kiotviet_return_id=$1", [item.id]);
      if (!synced.length) {
        await enqueueJob("sync", "kiotviet_return_to_shopify", { returnId: item.id }, "high", `kiotviet-return-${item.id}`);
        queued++;
      }
    }
    currentItem += page.pageSize || 100;
  }
  await query("INSERT INTO system_settings(key,value,updated_at) VALUES('kiotviet_returns_cursor',$1,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify({ lastModifiedFrom: latest })]);
  const stuck = await query<{ kiotviet_return_id: string; attempt_count: number }>(
    `SELECT kiotviet_return_id::text,attempt_count FROM refund_mappings
    WHERE financial_refund_id IS NULL AND kiotviet_return_id IS NOT NULL AND attempt_count < 10 AND (
      (status='processing' AND claimed_at < now()-make_interval(secs=>$1)) OR
      (status='sending' AND claim_token IS NULL AND updated_at < now()-interval '2 minutes') OR
      -- a worker that died with refundCreate in flight: reconcile once its claim expired
      (status='sending' AND claim_token IS NOT NULL AND claimed_at < now()-make_interval(secs=>$1)))
    ORDER BY updated_at LIMIT 20`,
    [RETURN_CLAIM_LEASE_MS / 1000]);
  for (const row of stuck) {
    await enqueueJob("sync", "kiotviet_return_to_shopify", { returnId: Number(row.kiotviet_return_id) }, "high", `kiotviet-return-${row.kiotviet_return_id}-a${row.attempt_count}`);
    queued++;
  }
  return { queued, lastModifiedFrom: latest };
}
