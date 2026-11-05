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

export type InvoiceFilter = "payment_review" | "needs_review";

export const invoicesRepository = {
  /** Most recently changed invoice states with their blocker and Product-Only amounts. */
  /**
   * Most recently changed invoice states. Invoice existence (invoice code, status) and payment
   * verification (payment_status) are separate. filter: payment_review = payment mismatch or
   * unverified on an existing invoice; needs_review = invoice verification needs a person.
   */
  async recent(limit = 100, filter?: InvoiceFilter) {
    const where = filter === "payment_review" ? "WHERE i.kiotviet_invoice_id IS NOT NULL AND i.payment_status IN ('mismatch','unverified')"
      : filter === "needs_review" ? "WHERE i.status='needs_review'" : "";
    return query<Record<string, unknown>>(
      `SELECT concat_ws(' ',o.shopify_order_number,'('||i.shopify_order_id||')') AS shopify_order,
        COALESCE(i.kiotviet_invoice_code,'—') AS invoice,i.status,i.payment_status,
        i.reconciliation->'paymentVerification'->>'expectedPaid' AS expected_paid,
        COALESCE(i.reconciliation->'paymentVerification'->>'invoiceTotalPayment',i.reconciliation->'invoice'->>'totalPayment') AS invoice_paid,
        i.reconciliation->'paymentVerification'->>'remainingBalance' AS outstanding,
        (SELECT string_agg(d,'; ') FROM jsonb_array_elements_text(COALESCE(i.reconciliation->'paymentVerification'->'discrepancies','[]'::jsonb)) d) AS payment_discrepancies,
        i.last_error
      FROM invoice_mappings i LEFT JOIN order_mappings o ON o.shopify_order_id=i.shopify_order_id
      ${where} ORDER BY i.updated_at DESC LIMIT $1`,
      [limit],
    );
  },
  /** Refunded-quantity adjustments per product line (invoiced and blocked orders), newest first. */
  async lineAdjustments(limit = 100) {
    return query<Record<string, unknown>>(
      `SELECT concat_ws(' ',o.shopify_order_number,'('||i.shopify_order_id||')') AS shopify_order,i.status,
        a->>'sku' AS sku,(a->>'originalQuantity')::int AS original_quantity,(a->>'excludedQuantity')::int AS excluded_quantity,
        (a->>'remainingQuantity')::int AS remaining_quantity,a->>'reason' AS reason,a->>'fulfilledQuantity' AS fulfilled_quantity,a->>'detail' AS detail
      FROM invoice_mappings i LEFT JOIN order_mappings o ON o.shopify_order_id=i.shopify_order_id,
        jsonb_array_elements(COALESCE(i.reconciliation->'productOnly'->'lineAdjustments',i.reconciliation->'lineAdjustments','[]'::jsonb)) a
      ORDER BY i.updated_at DESC LIMIT $1`,
      [limit],
    );
  },
  /** Status counts, post-creation payment checks and invoice latency (trigger → verified invoice, last 7 days). */
  async automationStats() {
    const [[counts], [latency], [lookup]] = await Promise.all([
      query<Record<string, string>>(`SELECT
        count(*) FILTER (WHERE status='pending')::text AS pending, count(*) FILTER (WHERE status='creating')::text AS processing,
        count(*) FILTER (WHERE status='created')::text AS created, count(*) FILTER (WHERE status='blocked')::text AS blocked,
        count(*) FILTER (WHERE status='needs_review')::text AS needs_review, count(*) FILTER (WHERE status='failed')::text AS failed,
        count(*) FILTER (WHERE payment_status='verified')::text AS payment_verified,
        count(*) FILTER (WHERE payment_status='mismatch')::text AS payment_mismatch,
        count(*) FILTER (WHERE payment_status='unverified')::text AS payment_unverified,
        count(*) FILTER (WHERE reconciliation->>'shopifyStockSynchronized'='false')::text AS stock_unsynced
      FROM invoice_mappings`),
      query<{ samples: string; avg_ms: string | null; p95_ms: string | null; within_60s: string }>(`SELECT count(*)::text AS samples,
        round(avg(ms))::text AS avg_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::text AS p95_ms,
        count(*) FILTER (WHERE ms<=60000)::text AS within_60s
      FROM (SELECT (reconciliation->'timings'->>'invoiceLatencyMs')::numeric AS ms FROM invoice_mappings
        WHERE kiotviet_invoice_id IS NOT NULL AND invoiced_at>now()-interval '7 days' AND reconciliation->'timings' ? 'invoiceLatencyMs') t`),
      // Duplicate lookups of the plan and the pre-POST re-check (reconciliation.duplicateLookup / prePostLookup).
      query<Record<string, string | null>>(`SELECT count(*)::text AS samples,
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY local_ms)::numeric,1)::text AS local_p95_ms,
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY refresh_ms)::numeric,1)::text AS refresh_p95_ms,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)::numeric,1)::text AS total_p50_ms,
        round(avg(total_ms)::numeric,1)::text AS total_avg_ms,
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::numeric,1)::text AS total_p95_ms,
        round(avg(api_calls)::numeric,2)::text AS api_calls_avg,
        count(*) FILTER (WHERE freshness IN ('reused','joined'))::text AS shared
      FROM (SELECT (l->>'localMs')::float8 AS local_ms,(l->>'refreshMs')::float8 AS refresh_ms,(l->>'totalMs')::float8 AS total_ms,(l->>'apiCalls')::float8 AS api_calls,l->>'freshness' AS freshness
        FROM invoice_mappings, LATERAL (VALUES (reconciliation->'duplicateLookup'),(reconciliation->'prePostLookup')) v(l)
        WHERE invoiced_at>now()-interval '7 days' AND jsonb_typeof(l)='object') t`),
    ]);
    const number = (value: string | null | undefined) => (value == null ? null : Number(value));
    return {
      counts: Object.fromEntries(Object.entries(counts ?? {}).map(([key, value]) => [key, Number(value)])) as Record<string, number>,
      latency: { samples: Number(latency?.samples ?? 0), avgMs: number(latency?.avg_ms), p95Ms: number(latency?.p95_ms), within60s: Number(latency?.within_60s ?? 0) },
      lookup: {
        samples: Number(lookup?.samples ?? 0), localP95Ms: number(lookup?.local_p95_ms), refreshP95Ms: number(lookup?.refresh_p95_ms),
        totalP50Ms: number(lookup?.total_p50_ms), totalAvgMs: number(lookup?.total_avg_ms),
        totalP95Ms: number(lookup?.total_p95_ms), apiCallsAvg: number(lookup?.api_calls_avg), shared: Number(lookup?.shared ?? 0),
      },
    };
  },
};
