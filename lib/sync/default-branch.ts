import type { QueryResultRow } from "pg";
import { query } from "@/lib/db/client";
import { PermanentError } from "@/lib/errors";
import { getActiveKiotVietBranches } from "@/lib/kiotviet/branches";

export interface OrderSettings {
  autoCreate?: boolean;
  paidOnly?: boolean;
  syncCustomers?: boolean;
  syncCancellation?: boolean;
  syncRefunds?: boolean;
  defaultBranchId?: number | string | null;
  /** Create the KiotViet invoice together with new orders (makeInvoice). Default false. */
  autoInvoice?: boolean;
  invoiceCreationTrigger?: "shopify_fulfilled" | "shopify_paid" | "disabled";
  invoiceTriggerEnabledAt?: string;
  /** Currency that KiotViet prices are recorded in; must equal the Shopify order currency to invoice. */
  kiotVietCurrency?: string;
  /**
   * KiotViet "thu khác" (GET /surchages) that records Shopify shipping on the
   * KiotViet order (documented POST /orders `surchages`). Shipping is never
   * added to product prices. Invoicing orders with shipping additionally requires
   * invoiceInheritsFromOrder=true, set after confirming in KiotViet that an
   * invoice created from an order keeps the order's surcharge.
   */
  shippingSurcharge?: { id: number; code: string; invoiceInheritsFromOrder?: boolean };
  /**
   * Set only after accounting verified, on a real KiotViet invoice, how an
   * order's prepayment is carried to an invoice created from it. Until then the
   * manual override cannot invoice prepaid orders (no double payment risk).
   */
  invoicePrepaymentVerified?: boolean;
  /** Shopify line items that are payment-processing fees, never KiotViet products. See lib/sync/order-line-items.ts. */
  processingFeeVariantIds?: Array<number | string>;
  processingFeeProductIds?: Array<number | string>;
  /** Exact titles; applied only to lines without a SKU. Defaults to DEFAULT_PROCESSING_FEE_TITLES. */
  processingFeeTitles?: string[];
  /**
   * Product-Only Invoicing: KiotViet orders and invoices carry only product
   * merchandise; excluded charges are recorded as differences instead of
   * blocking. See lib/sync/product-only-invoicing.ts. Default false (strict).
   */
  productOnlyInvoicing?: boolean;
  /** Authority for "the customer has paid". Only Shopify is supported. */
  paymentSource?: "shopify";
  ignoreFinancialMismatch?: boolean;
  excludeShipping?: boolean;
  excludeProcessingFees?: boolean;
  excludeOtherSurcharges?: boolean;
  /**
   * Product-Only only, default false: an order whose KiotViet prepayment equals the
   * invoice may be invoiced (totalPayment 0) before inheritance is proven; the
   * invoice's payment is verified right after creation and any discrepancy is
   * needs_review. Requires acknowledgeUnverifiedPrepaymentRisk (set by an admin).
   */
  allowUnverifiedPrepaymentInheritance?: boolean;
  acknowledgeUnverifiedPrepaymentRisk?: boolean;
  unverifiedPrepaymentAcceptedAt?: string;
  unverifiedPrepaymentAcceptedBy?: string;
  /** block (default): never invoiced; manual_override: admin override per order (stays needs_review). */
  prepaymentExceedsInvoicePolicy?: "block" | "manual_override";
  /**
   * Product-Only, merchant business policy for refunded product units:
   * - verify_unshipped (default): excluded only when Shopify proves they were never shipped;
   * - refund_means_not_shipped: this merchant never ships a refunded product, so every refunded
   *   unit is excluded regardless of fulfillment or restock type (no manual approval).
   */
  refundedItemsPolicy?: "verify_unshipped" | "refund_means_not_shipped";
  [key: string]: unknown;
}

export interface SettingsClient {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

const poolClient: SettingsClient = {
  async query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ) {
    const rows = await query<T>(text, values);
    return { rows };
  },
};

export async function resolveDefaultBranchId(
  client: SettingsClient = poolClient,
  knownSettings?: OrderSettings,
): Promise<number> {
  const settings =
    knownSettings ??
    (
      await client.query<{ value: OrderSettings }>(
        "SELECT value FROM system_settings WHERE key='orders'",
      )
    ).rows[0]?.value ??
    {};
  const activeBranches = await getActiveKiotVietBranches();
  const configuredBranchId = Number(settings.defaultBranchId);
  if (
    Number.isInteger(configuredBranchId) &&
    configuredBranchId > 0 &&
    activeBranches.some((branch) => branch.id === configuredBranchId)
  )
    return configuredBranchId;

  if (!activeBranches.length)
    throw new PermanentError(
      "No active KiotViet branches exist; configure a default branch manually",
    );
  if (activeBranches.length > 1)
    throw new PermanentError(
      "Multiple active KiotViet branches exist and the configured branch is unavailable; configure orders.defaultBranchId manually",
    );

  const branchId = activeBranches[0].id;
  const activeBranchIds = activeBranches.map((branch) => branch.id);
  const updated = await client.query<{ default_branch_id: string }>(
    `INSERT INTO system_settings(key,value,updated_at)
    VALUES('orders',jsonb_build_object('defaultBranchId',$1::bigint),now())
    ON CONFLICT(key) DO UPDATE SET
      value=system_settings.value || EXCLUDED.value,
      updated_at=now()
    WHERE CASE
      WHEN system_settings.value->>'defaultBranchId' ~ '^[1-9][0-9]*$'
      THEN (system_settings.value->>'defaultBranchId')::bigint <> ALL($2::bigint[])
      ELSE true
    END
    RETURNING value->>'defaultBranchId' AS default_branch_id`,
    [branchId, activeBranchIds],
  );
  if (updated.rows[0]?.default_branch_id)
    return Number(updated.rows[0].default_branch_id);

  const current = await client.query<{ default_branch_id: string }>(
    "SELECT value->>'defaultBranchId' AS default_branch_id FROM system_settings WHERE key='orders'",
  );
  const currentBranchId = Number(current.rows[0]?.default_branch_id);
  if (activeBranchIds.includes(currentBranchId)) return currentBranchId;
  throw new PermanentError(
    "Default KiotViet branch could not be initialized; configure orders.defaultBranchId manually",
  );
}
