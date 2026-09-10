import { randomUUID } from "node:crypto";
import { transaction } from "@/lib/db/client";
import type { JobPriority, JobType, SyncJobPayload } from "@/lib/queue/jobs";

export function isInventoryReconciliation(type: string) {
  return type === "inventory_reconciliation" || type === "full_inventory_sync";
}

// Audit rows cover the entire chain, including delayed retries and queued pages.
// Admission is serialized across scheduler, API, and worker processes.
export async function admitInventoryReconciliation(
  type: JobType,
  payload: SyncJobPayload,
  priority: JobPriority,
  maxAttempts: number,
  auditId?: string,
) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-reconciliation',0))");
    const { rows } = await client.query<{ id: string; chain_id: string }>(`
      SELECT id, COALESCE(payload->>'reconciliationChainId',
        CASE WHEN COALESCE(payload->>'currentItem','0') <> '0'
          THEN 'legacy-inventory' ELSE id::text END) AS chain_id
      FROM sync_jobs
      WHERE type IN ('inventory_reconciliation','full_inventory_sync')
        AND NOT (payload ? 'eventId')
        AND (status IN ('pending','processing') OR (status='failed' AND attempts < max_attempts))
      ORDER BY created_at,id LIMIT 1`);
    const chainId = payload.reconciliationChainId ??
      (Number(payload.currentItem ?? 0) > 0 ? "legacy-inventory" : auditId ?? randomUUID());
    if (rows[0] && rows[0].chain_id !== chainId)
      return { id: rows[0].id, payload, deduplicated: true };
    const chainPayload: SyncJobPayload = { ...payload, reconciliationChainId: chainId };
    if (auditId) {
      await client.query("UPDATE sync_jobs SET payload=$2,updated_at=now() WHERE id=$1", [auditId, JSON.stringify(chainPayload)]);
      return { id: auditId, payload: chainPayload, deduplicated: false };
    }
    if (payload.reconciliationChainId && Number(payload.currentItem ?? 0) > 0) {
      // A parent can retry after already handing off its next page. Do not
      // create another audit row (or replay completed pages without Redis).
      const existing = await client.query<{ id: string }>(`
        SELECT id FROM sync_jobs
        WHERE type='inventory_reconciliation'
          AND payload->>'reconciliationChainId'=$1
          AND payload->>'currentItem'=$2
          AND NOT (status='manual_review' AND attempts=0 AND queue_job_id IS NULL)
        ORDER BY created_at LIMIT 1`, [chainId, String(payload.currentItem)]);
      if (existing.rows[0])
        return { id: existing.rows[0].id, payload: chainPayload, deduplicated: true };
    }
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO sync_jobs(type,payload,priority,max_attempts) VALUES($1,$2,$3,$4) RETURNING id",
      [type, JSON.stringify(chainPayload), priority, maxAttempts],
    );
    return { id: inserted.rows[0].id, payload: chainPayload, deduplicated: false };
  });
}
