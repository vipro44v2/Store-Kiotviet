import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { query } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { ConflictError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";
import type { KiotVietInvoiceInput } from "@/lib/kiotviet/invoices";
import { classifyInvoiceReasons } from "@/lib/sync/invoice-override-rules";
import { applyInvoiceRecovery, planInvoiceRecovery, type InvoiceProposal, type InvoiceRecoveryPlan } from "./kiotviet-invoice-recovery";

/**
 * Admin override: invoice an existing KiotViet order although selected
 * financial warnings remain (lib/sync/invoice-override-rules.ts). Two steps:
 * 1. preview: a fresh read-only dry run, signed into a 10-minute token bound to
 *    the admin, the order and a fingerprint of payload + remote state;
 * 2. submit: the dry run runs again; anything that changed, any hard block, or
 *    any unapproved warning rejects it. The existing applyInvoiceRecovery claim
 *    then rechecks invoice existence and order staleness right before the POST,
 *    and never resends an uncertain request.
 */
export const OVERRIDE_PREVIEW_TTL_MS = 10 * 60_000;

export interface InvoiceOverridePreview {
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  kiotVietOrder: { id: number; code: string } | null;
  amounts: (Pick<InvoiceProposal, "shopify" | "invoice" | "payment"> & { currency: string | null }) | null;
  /** Differences that remain after invoicing; the invoice is "reconciled" only when empty. */
  remainingDifferences: InvoiceProposal["remainingDifferences"];
  reconciled: boolean;
  lines: Array<{ productId: number; productCode: string; productName: string; quantity: number; price: number }>;
  warnings: Array<{ code: string; message: string }>;
  blockers: Array<{ code: string; message: string }>;
  payload: KiotVietInvoiceInput | null;
  submitAllowed: boolean;
}

function blocker(code: string, message: string) {
  return { code, message: `${code}: ${message}` };
}

export async function buildOverridePreview(orderId: string) {
  const plan = await planInvoiceRecovery(orderId);
  const action = plan.action;
  const reasons = action.kind === "blocked" ? action.reasons : plan.validationReasons ?? [];
  const { warnings, blockers } = classifyInvoiceReasons(reasons);
  if (action.kind === "none") blockers.push(blocker("existing_active_invoice", action.reason));
  if (action.kind === "link")
    blockers.push(blocker("existing_active_invoice", `KiotViet invoice ${action.invoice.code} already exists; link it with scripts/recover-kiotviet-invoice.ts`));
  if (action.kind === "reset_uncertain") blockers.push(blocker("invoice_outcome_unknown", "a previous attempt has an unknown outcome"));
  const proposal = action.kind === "blocked" || action.kind === "create_invoice" ? plan.proposal : undefined;
  if (!proposal && !blockers.length) blockers.push(blocker("no_invoice_proposal", "the dry run could not build an exact invoice"));
  for (const reason of proposal?.blockers ?? []) blockers.push({ code: reason.split(":")[0], message: reason });
  const preview: InvoiceOverridePreview = {
    shopifyOrderId: orderId,
    shopifyOrderName: plan.shopifySnapshot?.name ?? plan.mapping?.shopify_order_number ?? null,
    kiotVietOrder: plan.kiotVietOrder ? { id: plan.kiotVietOrder.id, code: plan.kiotVietOrder.code } : null,
    amounts: proposal ? {
      shopify: proposal.shopify, invoice: proposal.invoice, payment: proposal.payment,
      currency: plan.shopifySnapshot?.currency ?? null,
    } : null,
    remainingDifferences: proposal?.remainingDifferences ?? [],
    reconciled: proposal?.reconciled ?? false,
    lines: proposal?.input.invoiceDetails ?? [],
    warnings,
    blockers,
    payload: proposal?.input ?? null,
    submitAllowed: Boolean(proposal) && blockers.length === 0,
  };
  return { preview, plan, fingerprint: fingerprintOf(plan, preview) };
}

/** Changes to the payload, the remote orders or the local invoice state invalidate a preview. */
function fingerprintOf(plan: InvoiceRecoveryPlan, preview: InvoiceOverridePreview) {
  return createHash("sha256").update(JSON.stringify({
    orderId: preview.shopifyOrderId,
    payload: preview.payload,
    amounts: preview.amounts,
    warnings: preview.warnings.map((warning) => warning.message),
    blockers: preview.blockers.map((item) => item.message),
    invoiceVersion: plan.invoiceRow?.updated_at ?? null,
    kiotVietOrder: plan.kiotVietOrder ?? null,
    shopify: plan.shopifySnapshot ? { updatedAt: plan.shopifySnapshot.updated_at, total: plan.shopifySnapshot.total_price } : null,
  })).digest("hex");
}

interface PreviewClaims { orderId: string; fingerprint: string; admin: string; exp: number }

function sign(data: string) {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(`invoice-override:${data}`).digest("base64url");
}
export function signPreviewToken(claims: PreviewClaims) {
  const data = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${data}.${sign(data)}`;
}
export function verifyPreviewToken(token: string, expected: { orderId: string; admin: string }, now = Date.now()): PreviewClaims {
  const [data, signature] = String(token).split(".");
  const actual = data ? Buffer.from(sign(data)) : Buffer.alloc(0);
  if (!data || !signature || actual.length !== Buffer.from(signature).length || !timingSafeEqual(actual, Buffer.from(signature)))
    throw new ValidationError("The preview token is invalid; run the dry run again");
  const claims = JSON.parse(Buffer.from(data, "base64url").toString()) as PreviewClaims;
  if (claims.orderId !== expected.orderId || claims.admin !== expected.admin)
    throw new ValidationError("The preview belongs to another order or administrator; run the dry run again");
  if (!(claims.exp > now)) throw new ValidationError("The preview has expired; run the dry run again");
  return claims;
}

export async function previewInvoiceOverride(orderId: string, admin: string) {
  const { preview, fingerprint } = await buildOverridePreview(orderId);
  const previewToken = signPreviewToken({ orderId, fingerprint, admin, exp: Date.now() + OVERRIDE_PREVIEW_TTL_MS });
  return { preview, previewToken };
}

async function audit(action: string, admin: string, orderId: string, before: unknown, after: unknown, ipAddress?: string | null) {
  await query(
    "INSERT INTO audit_logs(actor_type,actor,action,entity_type,entity_id,before_data,after_data,ip_address) VALUES('admin',$1,$2,'shopify_order',$3,$4,$5,$6)",
    [admin, action, orderId, JSON.stringify(before), JSON.stringify(after), ipAddress && isIP(ipAddress) ? ipAddress : null],
  );
}

export interface OverrideSubmission {
  orderId: string;
  admin: string;
  previewToken: string;
  approvedWarnings: string[];
  confirm: boolean;
  reason: string;
  ipAddress?: string | null;
}

export async function submitInvoiceOverride(submission: OverrideSubmission) {
  const { orderId, admin } = submission;
  if (submission.confirm !== true) throw new ValidationError("Confirm the invoice preview before submitting");
  const reason = String(submission.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 1000) throw new ValidationError("Enter a reason of 10 to 1000 characters");
  const claims = verifyPreviewToken(submission.previewToken, { orderId, admin });

  // Independent server-side recheck: never trust what the browser displayed.
  const { preview, plan, fingerprint } = await buildOverridePreview(orderId);
  if (fingerprint !== claims.fingerprint)
    throw new ConflictError("The order, invoice state or payload changed since the preview; run the dry run again");
  if (!preview.submitAllowed || !plan.proposal)
    throw new ConflictError(`Invoice cannot be created: ${preview.blockers.map((item) => item.message).join("; ")}`);
  const required = [...new Set(preview.warnings.map((warning) => warning.code))].sort();
  const approved = [...new Set(submission.approvedWarnings ?? [])].sort();
  if (JSON.stringify(required) !== JSON.stringify(approved))
    throw new ValidationError(`Approve exactly these warnings: ${required.join(", ") || "(none)"}`);

  const proposal = plan.proposal;
  const payloadSummary = {
    kiotVietOrderId: preview.kiotVietOrder?.id, kiotVietOrderCode: preview.kiotVietOrder?.code,
    invoiceTotal: proposal.invoice.total, prepaid: proposal.payment.existingPrepayment,
    additionalPayment: proposal.payment.additionalPayment, remainingDifferences: proposal.remainingDifferences,
    lines: proposal.input.invoiceDetails.map(({ productId, productCode, quantity, price }) => ({ productId, productCode, quantity, price })),
  };
  const at = new Date().toISOString();
  const manualOverride = { admin, reason, approvedWarnings: approved, at, payloadSummary };
  await audit("kiotviet_invoice_override_requested", admin, orderId, manualOverride, null, submission.ipAddress);

  let result: Awaited<ReturnType<typeof applyInvoiceRecovery>>;
  try {
    result = await applyInvoiceRecovery(
      { ...plan, expectedTotal: proposal.invoice.total, action: { kind: "create_invoice", input: proposal.input } },
      { reconciliation: {
        approvedWarnings: approved, expectedPaymentTotal: proposal.payment.totalRecorded, manualOverride,
        remainingDifferences: proposal.remainingDifferences,
      } },
    );
  } catch (error) {
    await audit("kiotviet_invoice_override_result", admin, orderId, manualOverride,
      { applied: false, error: error instanceof Error ? error.message : String(error) }, submission.ipAddress);
    throw error;
  }
  await audit("kiotviet_invoice_override_result", admin, orderId, manualOverride, result, submission.ipAddress);
  await log(result.applied ? "warn" : "error", "KiotViet invoice created by admin override", {
    action: "kiotviet_invoice_override", provider: "kiotviet", entityType: "invoice", entityId: orderId,
    admin, approvedWarnings: approved, applied: result.applied, result: result.message, ...payloadSummary,
  });
  return result;
}
