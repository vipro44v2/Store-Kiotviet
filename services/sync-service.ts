import { initializeProductMappings } from "@/lib/sync/product-sync";
import { reconcileInventoryPage } from "@/lib/sync/reconciliation";
export const syncService = {
  initializeMappings: initializeProductMappings,
  reconcileInventory: reconcileInventoryPage,
};
