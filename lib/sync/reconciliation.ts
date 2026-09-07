import { getKiotVietInventory } from "@/lib/kiotviet/inventory";
import { syncInventoryNotification } from "./inventory-sync";
import { enqueueJob } from "@/lib/queue/queues";
import { query } from "@/lib/db/client";
import { ConflictError, MappingError, PermanentError, RetryableError, ValidationError } from "@/lib/errors";

export async function reconcileInventoryPage(currentItem = 0, jobId?: string) {
  const page = await getKiotVietInventory(currentItem, 100);
  const errors: string[] = [];
  let hasRetryableFailure = false;
  for (const product of page.data) {
    for (const inventory of product.inventories) {
      try {
        await syncInventoryNotification({
          ProductId: product.id, ProductCode: product.code, ProductName: product.code,
          BranchId: inventory.branchId, BranchName: String(inventory.branchId),
          Cost: 0, OnHand: inventory.onHand, Reserved: inventory.reserved,
        }, jobId);
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
    await enqueueJob("reconciliation", "inventory_reconciliation", { currentItem: next }, "low", `inventory-reconciliation-${next}`);
  // Keep processing other products/pages, but let the worker fail this audit job.
  if (errors.length) {
    const message = `Inventory reconciliation failed: ${errors.join("; ")}`;
    throw hasRetryableFailure ? new RetryableError(message) : new MappingError(message);
  }
  return { processed: page.data.length, next: next < page.total ? next : null, total: page.total };
}

export async function cleanupOldData(){await query("DELETE FROM webhook_events WHERE status='processed' AND received_at < now()-interval '30 days'");await query("DELETE FROM sync_jobs WHERE status='completed' AND completed_at < now()-interval '30 days'");await query("DELETE FROM sync_logs WHERE created_at < now()-interval '90 days'");await query("DELETE FROM audit_logs WHERE created_at < now()-interval '180 days'");}
