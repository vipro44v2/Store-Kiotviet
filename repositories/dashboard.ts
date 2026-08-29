import { query } from "@/lib/db/client";

export async function getDashboardData() {
  const [mappings, jobs, conflicts, events, integrations, recent] =
    await Promise.all([
      query<{ mapped: string; unmapped: string }>(
        "SELECT count(*) FILTER(WHERE shopify_variant_id IS NOT NULL AND kiotviet_product_id IS NOT NULL)::text mapped,count(*) FILTER(WHERE shopify_variant_id IS NULL OR kiotviet_product_id IS NULL)::text unmapped FROM product_mappings",
      ),
      query<{ status: string; count: string }>(
        "SELECT status,count(*)::text count FROM sync_jobs GROUP BY status",
      ),
      query<{ count: string }>(
        "SELECT count(*)::text count FROM sync_conflicts WHERE resolution_status='open'",
      ),
      query<{ count: string }>(
        "SELECT count(*)::text count FROM webhook_events WHERE received_at >= current_date",
      ),
      query<Record<string, unknown>>(
        "SELECT * FROM integrations ORDER BY provider",
      ),
      query<Record<string, unknown>>(
        "SELECT date_trunc('day',created_at)::date day,count(*) FILTER(WHERE status='completed')::int success,count(*) FILTER(WHERE status IN ('failed','manual_review'))::int failed FROM sync_jobs WHERE created_at >= now()-interval '7 days' GROUP BY 1 ORDER BY 1",
      ),
    ]);
  return {
    mappings: mappings[0] ?? { mapped: "0", unmapped: "0" },
    jobs,
    conflicts: conflicts[0]?.count ?? "0",
    webhooksToday: events[0]?.count ?? "0",
    integrations,
    recent,
  };
}
