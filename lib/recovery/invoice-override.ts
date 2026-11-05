import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { query } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { ConflictError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";
import type { KiotVietInvoiceInput } from "@/lib/kiotviet/invoices";
import { classifyInvoiceReasons } from "@/lib/sync/invoice-override-rules";
import type { OrderSettings } from "@/lib/sync/default-branch";
import { productOnlyPolicy } from "@/lib/sync/product-only-invoicing";
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
  /** Result of the strict dry run ("PLAN: blocked" when any validation reason exists). */
  planStatus: InvoiceRecoveryPlan["action"]["kind"];
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  /** Seller verification status only; the soldById itself never leaves the server. */
  seller: { verified: boolean; source: "order" | "default" | null };
  sellerRejected: string[];
  kiotVietOrder: { id: number; code: string } | null;
  amounts: (Pick<InvoiceProposal, "shopify" | "invoice" | "payment"> & { currency: string | null }) | null;
  /** Differences that remain after invoicing; the invoice is "reconciled" only when empty. */
  remainingDifferences: InvoiceProposal["remainingDifferences"];
  reconciled: boolean;
  lines: Array<{ productId: number; productCode: string; productName: string; quantity: number; price: number }>;
  warnings: Array<{ code: string; message: string }>;
  blockers: Array<{ code: string; message: string }>;
  /** Exact POST /invoices body, with soldById shown only as "[verified seller]". */
  payload: (Omit<KiotVietInvoiceInput, "soldById"> & { soldById?: string }) | null;
  submitAllowed: boolean;
}

function blocker(code: string, message: string) {
  return { code, message: `${code}: ${message}` };
}

export async function buildOverridePreview(orderId: string) {
  const plan = await planInvoiceRecovery(orderId);
  const action = plan.action;
  const reasons = action.kind === "blocked" ? action.reasons : plan.validationReasons ?? [];
  const { warnings: classified, blockers } = classifyInvoiceReasons(reasons);
  // A prepayment larger than the product-only invoice (e.g. #1071) has its own explicit
  // policy: overridable only when orders.prepaymentExceedsInvoicePolicy is manual_override.
  const [settingsRow] = await query<{ value: OrderSettings }>("SELECT value FROM system_settings WHERE key='orders'");
  const overpaymentOverridable = productOnlyPolicy(settingsRow?.value ?? {}).prepaymentExceedsInvoicePolicy === "manual_override";
  const warnings = classified.filter((warning) => {
    if (warning.code !== "prepayment_exceeds_invoice" || overpaymentOverridable) return true;
    blockers.push({ code: warning.code, message: `${warning.message} (orders.prepaymentExceedsInvoicePolicy is "block")` });
    return false;
  });
  if (action.kind === "none") blockers.push(blocker("existing_active_invoice", action.reason));
  if (action.kind === "link")
    blockers.push(blocker("existing_active_invoice", `KiotViet invoice ${action.invoice.code} already exists; link it with scripts/recover-kiotviet-invoice.ts`));
  if (action.kind === "reset_uncertain") blockers.push(blocker("invoice_outcome_unknown", "a previous attempt has an unknown outcome"));
  const proposal = action.kind === "blocked" || action.kind === "create_invoice" ? plan.proposal : undefined;
  if (!proposal && !blockers.length) blockers.push(blocker("no_invoice_proposal", "the dry run could not build an exact invoice"));
  for (const reason of proposal?.blockers ?? []) blockers.push({ code: reason.split(":")[0], message: reason });
  const preview: InvoiceOverridePreview = {
    planStatus: action.kind,
    shopifyOrderId: orderId,
    shopifyOrderName: plan.shopifySnapshot?.name ?? plan.mapping?.shopify_order_number ?? null,
    seller: { verified: Boolean(plan.seller), source: plan.seller?.source ?? null },
    sellerRejected: plan.sellerRejected ?? [],
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
    payload: proposal ? redactSeller(proposal.input) : null,
    submitAllowed: Boolean(proposal) && blockers.length === 0,
  };
  return { preview, plan, fingerprint: fingerprintOf(plan, preview) };
}

function redactSeller(input: KiotVietInvoiceInput) {
  const { soldById, ...rest } = input;
  return soldById ? { ...rest, soldById: "[verified seller]" } : rest;
}

/** Changes to the payload, the remote orders or the local invoice state invalidate a preview. */
function fingerprintOf(plan: InvoiceRecoveryPlan, preview: InvoiceOverridePreview) {
  return createHash("sha256").update(JSON.stringify({
    orderId: preview.shopifyOrderId,
    // The real payload and seller (server-side only, hashed): a seller change invalidates the preview.
    payload: plan.proposal?.input ?? null,
    seller: plan.seller ?? null,
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
  /** Explicit "Bỏ qua PLAN: blocked" decision; required whenever the strict plan is blocked by warnings. */
  bypassPlanBlocked?: boolean;
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
  if (preview.warnings.length && submission.bypassPlanBlocked !== true)
    throw new ValidationError("The strict plan is blocked; tick \"Bỏ qua PLAN: blocked\" to override its financial warnings for this order only");
  const required = [...new Set(preview.warnings.map((warning) => warning.code))].sort();
  const approved = [...new Set(submission.approvedWarnings ?? [])].sort();
  if (JSON.stringify(required) !== JSON.stringify(approved))
    throw new ValidationError(`Approve exactly these warnings: ${required.join(", ") || "(none)"}`);

  const proposal = plan.proposal;
  const payloadSummary = {
    kiotVietOrderId: preview.kiotVietOrder?.id, kiotVietOrderCode: preview.kiotVietOrder?.code, seller: preview.seller.source,
    invoiceTotal: proposal.invoice.total, prepaid: proposal.payment.existingPrepayment,
    additionalPayment: proposal.payment.additionalPayment, remainingDifferences: proposal.remainingDifferences,
    lines: proposal.input.invoiceDetails.map(({ productId, productCode, quantity, price }) => ({ productId, productCode, quantity, price })),
  };
  const at = new Date().toISOString();
  const manualOverride = {
    admin, reason, at, payloadSummary, approvedWarnings: approved,
    bypassPlanBlocked: preview.warnings.length > 0, planStatus: preview.planStatus,
    planBlockedReasons: preview.warnings.map((warning) => warning.message),
  };
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
