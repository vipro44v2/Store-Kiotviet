import { connection } from "next/server";
import { notFound } from "next/navigation";
import { query } from "@/lib/db/client";
import { DataTable } from "@/components/admin/data-table";
import { ActionButton } from "@/components/admin/action-button";
import { ProductSyncTable } from "@/components/admin/product-sync-table";

const configs: Record<string, { title: string; sql: string; action?: string }> = {
  products: { title: "Products", sql: "" },
  mappings: { title: "Product mappings", sql: "SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT 200", action: "mappings" },
  inventory: { title: "Inventory", sql: "SELECT * FROM inventory_snapshots ORDER BY created_at DESC LIMIT 200", action: "inventory" },
  orders: { title: "Orders", sql: "SELECT * FROM order_mappings ORDER BY created_at DESC LIMIT 200", action: "orders" },
  customers: { title: "Customers", sql: "SELECT * FROM customer_mappings ORDER BY created_at DESC LIMIT 200" },
  jobs: { title: "Background jobs", sql: "SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT 200" },
  conflicts: { title: "Conflicts & manual review", sql: "SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT 200" },
  webhooks: { title: "Webhook deliveries", sql: "SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 200" },
  logs: { title: "Synchronization logs", sql: "SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT 200" },
  notifications: { title: "Notifications", sql: "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200" },
  settings: { title: "System settings", sql: "SELECT * FROM system_settings ORDER BY key" },
};

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  await connection();
  const { section } = await params;
  const config = configs[section];
  if (!config) notFound();
  let rows: Record<string, unknown>[] = [];
  let error = "";
  try {
    if (section !== "products")
      rows = await query<Record<string, unknown>>(config.sql);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Database unavailable";
  }
  return (
    <>
      {section !== "products" && <header className="admin-header">
        <div><p className="eyebrow">Administration</p><h1>{config.title}</h1></div>
        {config.action && <ActionButton action={config.action} label={`Run ${config.title}`} />}
      </header>}
      {error && <div className="error-banner">{error}</div>}
      {section === "products"
        ? <ProductSyncTable />
        : <DataTable rows={rows} resource={section} />}
    </>
  );
}
