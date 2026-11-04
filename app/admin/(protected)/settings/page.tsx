import { connection } from "next/server";
import { query } from "@/lib/db/client";
import { SettingsEditor } from "@/components/admin/settings-editor";
import { SyncSettingsCard } from "@/components/admin/sync-settings";
import { SYNC_SETTINGS_KEY } from "@/lib/settings/sync-settings";
export default async function SettingsPage() {
  await connection();
  let settings: Array<{ key: string; value: Record<string, unknown> }> = [],
    error = "";
  try {
    settings = await query(
      "SELECT key,value FROM system_settings ORDER BY key",
    );
  } catch (e) {
    error = e instanceof Error ? e.message : "Database unavailable";
  }
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
          <SyncSettingsCard
            stored={settings.find((setting) => setting.key === SYNC_SETTINGS_KEY)?.value}
            orders={settings.find((setting) => setting.key === "orders")?.value}
          />
        </div>
      )}
      <SettingsEditor settings={settings} />
    </>
  );
}
