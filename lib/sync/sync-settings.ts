import { query } from "@/lib/db/client";
import {
  parseSyncSettings,
  SYNC_SETTINGS_KEY,
  type SynchronizationSettings,
} from "@/lib/settings/sync-settings";

/** Read on every gated job so a change applies to jobs that are already queued. */
export async function getSyncSettings(): Promise<SynchronizationSettings> {
  const rows = await query<{ value: unknown }>(
    "SELECT value FROM system_settings WHERE key=$1",
    [SYNC_SETTINGS_KEY],
  );
  return parseSyncSettings(rows[0]?.value);
}
