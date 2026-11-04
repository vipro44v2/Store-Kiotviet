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
  /** Shopify line items that are payment-processing fees, never KiotViet products. See lib/sync/order-line-items.ts. */
  processingFeeVariantIds?: Array<number | string>;
  processingFeeProductIds?: Array<number | string>;
  /** Exact titles; applied only to lines without a SKU. Defaults to DEFAULT_PROCESSING_FEE_TITLES. */
  processingFeeTitles?: string[];
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
