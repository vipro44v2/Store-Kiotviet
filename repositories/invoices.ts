import { query } from "@/lib/db/client";

/**
 * invoice_mappings.status → the workflow status shown to administrators.
 * 'creating' means the POST was (or may have been) sent: shown as processing.
 */
export const INVOICE_DISPLAY_STATUS: Record<string, string> = {
  pending: "pending",
  creating: "processing",
  created: "created",
  blocked: "blocked",
  needs_review: "needs_review",
  failed: "failed",
};

export const invoicesRepository = {
  /** Most recently changed invoice states with their blocker and Product-Only amounts. */
  async recent(limit = 100) {
    return query<Record<string, unknown>>(
      `SELECT concat_ws(' ',o.shopify_order_number,'('||i.shopify_order_id||')') AS shopify_order,i.kiotviet_order_code AS kiotviet_order,
        i.kiotviet_invoice_code AS invoice,i.status,substring(i.last_error from '^([a-z][a-z0-9_]*):') AS error_code,
        i.failure_stage,i.reconciliation->'productOnly'->>'invoiceMerchandise' AS invoice_merchandise,
        i.reconciliation->'productOnly'->>'shopifyPaid' AS shopify_paid,i.last_error,i.updated_at
      FROM invoice_mappings i LEFT JOIN order_mappings o ON o.shopify_order_id=i.shopify_order_id
      ORDER BY i.updated_at DESC LIMIT $1`,
      [limit],
    );
  },
  async counts() {
    return query<{ status: string; count: string }>("SELECT status,count(*)::text AS count FROM invoice_mappings GROUP BY status ORDER BY status");
  },
};
