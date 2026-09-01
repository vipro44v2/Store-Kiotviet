import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { query } from "@/lib/db/client";
const queries: Record<string, string> = {
  products: "SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT 200",
  mappings: "SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT 200",
  inventory:
    "SELECT * FROM inventory_snapshots ORDER BY created_at DESC LIMIT 200",
  orders: "SELECT * FROM order_mappings ORDER BY created_at DESC LIMIT 200",
  customers:
    "SELECT * FROM customer_mappings ORDER BY created_at DESC LIMIT 200",
  jobs: "SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT 200",
  conflicts: "SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT 200",
  webhooks: "SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 200",
  logs: "SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT 200",
  notifications:
    "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200",
  settings: "SELECT * FROM system_settings ORDER BY key",
};
export async function GET(
  _request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  try {
    await requireAdmin();
    const { resource } = await context.params;
    const sql = queries[resource];
    if (!sql)
      return Response.json({ error: "Unknown resource" }, { status: 404 });
    return Response.json({
      success: true,
      data: await query<Record<string, unknown>>(sql),
    });
  } catch (error) {
    return adminApiErrorResponse(error, "Resource unavailable", 500);
  }
}
