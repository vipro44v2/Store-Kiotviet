import { connection } from "next/server";
import { query } from "@/lib/db/client";
import { SettingsEditor } from "@/components/admin/settings-editor";
import { SyncSettingsCard } from "@/components/admin/sync-settings";
import { InvoiceAutomationStatus, type InvoiceAutomationStats } from "@/components/admin/invoice-automation-status";
import { SYNC_SETTINGS_KEY } from "@/lib/settings/sync-settings";
import { getInvoiceIndexHealth, type InvoiceIndexHealth } from "@/lib/kiotviet/invoice-index";
import { invoicesRepository } from "@/repositories/invoices";
export default async function SettingsPage() {
  await connection();
  let settings: Array<{ key: string; value: Record<string, unknown> }> = [],
    error = "";
  let index: InvoiceIndexHealth | null = null, stats: InvoiceAutomationStats | null = null;
  try {
    settings = await query(
      "SELECT key,value FROM system_settings ORDER BY key",
    );
    // Status only; a missing table (migration not yet run) must not hide the settings.
    [index, stats] = await Promise.all([getInvoiceIndexHealth().catch(() => null), invoicesRepository.automationStats().catch(() => null)]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Database unavailable";
  }
  const orders = settings.find((setting) => setting.key === "orders")?.value;
  return (
    <>
      <header className="admin-header">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>System settings</h1>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      {!error && (
        <div className="settings-grid">
          <InvoiceAutomationStatus orders={orders} index={index} stats={stats} />
          <SyncSettingsCard
            stored={settings.find((setting) => setting.key === SYNC_SETTINGS_KEY)?.value}
            orders={orders}
          />
        </div>
      )}
      <SettingsEditor settings={settings} />
    </>
  );
}
