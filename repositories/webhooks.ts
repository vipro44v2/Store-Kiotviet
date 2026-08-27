import { query } from "@/lib/db/client";

interface WebhookInsert { id: string; inserted: boolean; status: string }
export const webhooksRepository = {
  async store(provider: "shopify" | "kiotviet", webhookId: string, eventType: string, payload: unknown, headers: Record<string, string>, externalResourceId?: string) {
    const rows = await query<WebhookInsert>(`WITH ins AS (
      INSERT INTO webhook_events(provider,webhook_id,event_type,payload,headers,external_resource_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,webhook_id) DO NOTHING RETURNING id
    ) SELECT id,true inserted,'received' status FROM ins UNION ALL SELECT id,false,status FROM webhook_events WHERE provider=$1 AND webhook_id=$2 LIMIT 1`,
    [provider, webhookId, eventType, JSON.stringify(payload), JSON.stringify(headers), externalResourceId ?? null]);
    if (!rows[0]) throw new Error("Unable to persist webhook event");
    return rows[0];
  },
  async markProcessed(id: string) { await query("UPDATE webhook_events SET status='processed',processed_at=now(),error=NULL WHERE id=$1", [id]); },
  async markFailed(id: string, error: string) { await query("UPDATE webhook_events SET status='failed',error=$2 WHERE id=$1", [id, error]); },
  async get(id: string) { return (await query<Record<string, unknown>>("SELECT * FROM webhook_events WHERE id=$1", [id]))[0]; },
  async list(limit = 100) { return query<Record<string, unknown>>("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT $1", [limit]); },
};
