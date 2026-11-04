import { getKiotVietInventory } from "@/lib/kiotviet/inventory";
import { syncInventoryNotification, type InventorySyncOptions } from "./inventory-sync";
import { enqueueJob } from "@/lib/queue/queues";
import { query } from "@/lib/db/client";
import { ConflictError, MappingError, PermanentError, RetryableError, ValidationError } from "@/lib/errors";
import { randomUUID } from "node:crypto";

export async function reconcileInventoryPage(currentItem = 0, jobId?: string, reconciliationChainId: string = randomUUID(), options: InventorySyncOptions = {}) {
  if (!Number.isSafeInteger(currentItem) || currentItem < 0)
    throw new ValidationError("Invalid inventory reconciliation offset");
  const page = await getKiotVietInventory(currentItem, 100);
  if (!Number.isSafeInteger(page.pageSize) || page.pageSize <= 0 ||
      !Number.isSafeInteger(page.total) || page.total < 0 ||
      (currentItem < page.total && page.data.length === 0))
    throw new RetryableError("Inventory reconciliation pagination made no progress");
  const errors: string[] = [];
  let hasRetryableFailure = false;
  for (const product of page.data) {
    for (const inventory of product.inventories) {
      try {
        await syncInventoryNotification({
          ProductId: product.id, ProductCode: product.code, ProductName: product.code,
          BranchId: inventory.branchId, BranchName: String(inventory.branchId),
          Cost: 0, OnHand: inventory.onHand, Reserved: inventory.reserved,
        }, jobId, options);
      } catch (error) {
        if (!(error instanceof MappingError || error instanceof ConflictError || error instanceof PermanentError || error instanceof ValidationError))
          hasRetryableFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${product.code} (branch ${inventory.branchId}): ${message}`);
        await query(
          "INSERT INTO sync_conflicts(entity_type,entity_key,conflict_type,kiotviet_value) VALUES('inventory',$1,'inventory_reconciliation_error',$2)",
          [product.code, JSON.stringify({ message, branchId: inventory.branchId })],
        );
      }
    }
  }
  const next = currentItem + page.pageSize;
  if (next < page.total)
    // The next page is gated again by the worker, so disabling inventory sync stops the chain.
    await enqueueJob("reconciliation", "inventory_reconciliation", { currentItem: next, reconciliationChainId }, "low", `inventory-reconciliation-${reconciliationChainId}-${next}`);
  // Keep processing other products/pages, but let the worker fail this audit job.
  if (errors.length) {
    const message = `Inventory reconciliation failed: ${errors.join("; ")}`;
    throw hasRetryableFailure ? new RetryableError(message) : new MappingError(message);
  }
  return { processed: page.data.length, next: next < page.total ? next : null, total: page.total };
}

export async function cleanupOldData() {
  // One bounded batch per table per scheduler tick; never delete failed/manual_review or invoice outbox records.
  for (const [table, condition, time] of [
    ["webhook_events", "status IN ('processed','ignored') AND received_at < now()-interval '30 days'", "received_at"],
    ["sync_jobs", "type <> 'shopify_invoice_create' AND status IN ('completed','skipped') AND completed_at < now()-interval '30 days'", "completed_at"],
    ["sync_logs", "created_at < now()-interval '90 days'", "created_at"],
    ["audit_logs", "created_at < now()-interval '180 days'", "created_at"],
  ]) await query(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${condition} ORDER BY ${time} LIMIT 500 FOR UPDATE SKIP LOCKED)`);
}
