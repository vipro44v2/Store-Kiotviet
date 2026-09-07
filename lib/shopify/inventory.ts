import { randomUUID } from "node:crypto";
import { shopifyGraphql } from "./graphql";
import { ApiError, AuthenticationError, RetryableError } from "@/lib/errors";
import { log } from "@/lib/logger";

export interface ShopifyInventory {
  isActive: boolean;
  available: number | null;
  onHand: number | null;
}

async function inventoryRequest<T>(document: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await shopifyGraphql<T>(document, variables);
  } catch (error) {
    if (error instanceof AuthenticationError || /access denied|permission|scope/i.test(String(error))) {
      throw new AuthenticationError(`${error instanceof Error ? error.message : String(error)}; inventory reads require read_inventory; activation and quantity updates require write_inventory and staff inventory permissions`);
    }
    throw error;
  }
}

export async function getShopifyInventory(inventoryItemId: string, locationId: string): Promise<ShopifyInventory> {
  const data = await inventoryRequest<{
    inventoryItem: { inventoryLevel: { isActive: boolean; quantities: Array<{ name: string; quantity: number }> } | null } | null;
  }>(`query Inventory($id:ID!,$location:ID!){inventoryItem(id:$id){inventoryLevel(locationId:$location){isActive quantities(names:["available","on_hand"]){name quantity}}}}`, { id: inventoryItemId, location: locationId });
  if (!data.inventoryItem) throw new ApiError(`Shopify inventory item ${inventoryItemId} does not exist or is inaccessible`);
  const level = data.inventoryItem.inventoryLevel;
  const available = level?.quantities.find(q => q.name === "available")?.quantity ?? null;
  const onHand = level?.quantities.find(q => q.name === "on_hand")?.quantity ?? null;
  if (level && (available === null || onHand === null)) throw new ApiError(`Shopify inventory quantities missing for ${inventoryItemId} at ${locationId}`);
  return { isActive: level?.isActive === true, available, onHand };
}

type UserError = { field?: string[]; message: string };
type InventorySetQuantitiesUserError = UserError & { code?: string };
function checkUserErrors(operation: string, errors: InventorySetQuantitiesUserError[]) {
  if (errors.some(error => error.code === "CHANGE_FROM_QUANTITY_STALE"))
    throw new RetryableError(`${operation}: ${JSON.stringify(errors)}`);
  if (errors.length) throw new ApiError(`${operation}: ${JSON.stringify(errors)}; requires write_inventory and staff inventory permissions`);
}

export async function ensureShopifyInventoryActive(inventoryItemId: string, locationId: string, context: Record<string, unknown> = {}): Promise<ShopifyInventory> {
  const before = await getShopifyInventory(inventoryItemId, locationId);
  if (before.isActive) return before;
  await log("info", "inventory_activation_started", { ...context, inventoryItemId, locationId, action: "inventory_activation_started" });
  // API 2026-07: omitting both quantities preserves stock on an inactive level.
  // Never send zero or deactivate other locations when activating this mapping.
  const data = await inventoryRequest<{
    inventoryActivate: { inventoryLevel: { id: string } | null; userErrors: UserError[] };
  }>(`mutation ActivateInventory($inventoryItemId:ID!,$locationId:ID!,$idempotencyKey:String!){inventoryActivate(inventoryItemId:$inventoryItemId,locationId:$locationId) @idempotent(key:$idempotencyKey){inventoryLevel{id} userErrors{field message}}}`, { inventoryItemId, locationId, idempotencyKey: randomUUID() });
  checkUserErrors("inventoryActivate", data.inventoryActivate.userErrors);
  const after = await getShopifyInventory(inventoryItemId, locationId);
  if (!after.isActive) throw new RetryableError(`Inventory activation unverified for ${inventoryItemId} at ${locationId}`);
  await log("info", "inventory_activation_completed", { ...context, inventoryItemId, locationId, active: after, action: "inventory_activation_completed" });
  return after;
}

export async function setShopifyInventory(inventoryItemId: string, locationId: string, quantity: number, changeFromQuantity: number) {
  const data = await inventoryRequest<{
    inventorySetQuantities: { inventoryAdjustmentGroup?: { createdAt: string } | null; userErrors: InventorySetQuantitiesUserError[] };
  }>(`mutation SetInventory($input:InventorySetQuantitiesInput!,$idempotencyKey:String!){inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey){inventoryAdjustmentGroup{createdAt} userErrors{field message code}}}`, {
    input: { name: "available", reason: "correction", referenceDocumentUri: "gid://shopify/App/kiotviet-sync", quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity }] },
    idempotencyKey: randomUUID(),
  });
  checkUserErrors("inventorySetQuantities", data.inventorySetQuantities.userErrors);
  return data.inventorySetQuantities.inventoryAdjustmentGroup;
}
