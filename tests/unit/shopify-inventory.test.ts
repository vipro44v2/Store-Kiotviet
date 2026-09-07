import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ graphql: vi.fn(), query: vi.fn(), log: vi.fn(), findBySku: vi.fn() }));
vi.mock("@/lib/shopify/graphql", () => ({ shopifyGraphql: mocks.graphql }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/repositories/mappings", () => ({ mappingsRepository: { findBySku: mocks.findBySku } }));
import { ensureShopifyInventoryActive, getShopifyInventory } from "@/lib/shopify/inventory";
import { syncInventoryNotification } from "@/lib/sync/inventory-sync";
import { AuthenticationError, ConflictError, RetryableError } from "@/lib/errors";

const notification = { ProductId: 1, ProductCode: "1146", ProductName: "Test", BranchId: 10, BranchName: "Main", Cost: 0, OnHand: 9, Reserved: 0 };
const level = (available: number, isActive = true, onHand = available) => ({ inventoryItem: { inventoryLevel: { isActive, quantities: [{ name: "available", quantity: available }, { name: "on_hand", quantity: onHand }] } } });
const activation = { inventoryActivate: { inventoryLevel: { id: "level-1" }, userErrors: [] } };
const setResult = { inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: "now" }, userErrors: [] } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.findBySku.mockResolvedValue([{ shopify_inventory_item_id: "item-1" }]);
  mocks.query.mockImplementation(async (sql: string) => sql.includes("FROM branch_location_mappings") ? [{ shopify_location_id: "location-1", safety_stock: "0" }] : []);
});

it("does nothing for an already active inventory level with stock", async () => {
  mocks.graphql.mockResolvedValue(level(9));
  await expect(ensureShopifyInventoryActive("item-1", "location-1")).resolves.toMatchObject({ isActive: true, available: 9 });
  expect(mocks.graphql).toHaveBeenCalledTimes(1);
});

it("preserves existing available and on-hand stock when activating and is idempotent on retry", async () => {
  mocks.graphql.mockResolvedValueOnce(level(7, false, 12))
    .mockResolvedValueOnce(activation)
    .mockResolvedValue(level(7, true, 12));

  await expect(ensureShopifyInventoryActive("item-1", "location-1"))
    .resolves.toEqual({ isActive: true, available: 7, onHand: 12 });
  await ensureShopifyInventoryActive("item-1", "location-1");

  const mutations = mocks.graphql.mock.calls.filter(([document]) => document.includes("mutation"));
  expect(mutations).toHaveLength(1);
  expect(mutations[0][0]).not.toMatch(/available:|onHand:/);
  expect(mutations[0][1]).toEqual({ inventoryItemId: "item-1", locationId: "location-1", idempotencyKey: expect.any(String) });
});

it("activates even when the initial quantity matches expected and verifies without setting stock again", async () => {
  mocks.graphql.mockResolvedValueOnce(level(9, false))
    .mockResolvedValueOnce(level(9, false))
    .mockResolvedValueOnce(activation)
    .mockResolvedValue(level(9));

  await syncInventoryNotification(notification);

  expect(mocks.graphql.mock.calls.filter(([document]) => document.includes("inventoryActivate"))).toHaveLength(1);
  expect(mocks.graphql.mock.calls.some(([document]) => document.includes("inventorySetQuantities"))).toBe(false);
  expect(mocks.graphql).toHaveBeenCalledTimes(5);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO inventory_snapshots"), ["1146", 10, "location-1", 9, 9, 9, 0]);
});

it("fails on a read-back API error without recording a successful snapshot or completion log", async () => {
  mocks.graphql.mockResolvedValueOnce(level(0)).mockResolvedValueOnce(level(0))
    .mockResolvedValueOnce(setResult).mockRejectedValueOnce(new Error("Shopify read-back unavailable"));

  await expect(syncInventoryNotification(notification, "job-1")).rejects.toThrow("Shopify read-back unavailable");

  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO inventory_snapshots"))).toBe(false);
  expect(mocks.log.mock.calls.some(([, message]) => message === "inventory_set_completed")).toBe(false);
  expect(mocks.log).toHaveBeenCalledWith("error", expect.any(String), expect.objectContaining({ sku: "1146", inventoryItemId: "item-1", locationId: "location-1", before: 0, expected: 9, after: null, jobId: "job-1" }));
});

it.each([level(0, false, 9), { inventoryItem: { inventoryLevel: null } }])("activates an inactive or unstocked item, sets Available=9 and snapshots the read-back (%j)", async before => {
  mocks.graphql.mockResolvedValueOnce(before).mockResolvedValueOnce(before)
    .mockResolvedValueOnce(activation).mockResolvedValueOnce(level(4))
    .mockResolvedValueOnce(setResult).mockResolvedValueOnce(level(9));
  await syncInventoryNotification(notification);
  const activateCall = mocks.graphql.mock.calls[2];
  expect(activateCall[0]).toContain("inventoryActivate");
  expect(activateCall[0]).toContain("@idempotent");
  expect(activateCall[1]).toEqual({ inventoryItemId: "item-1", locationId: "location-1", idempotencyKey: expect.any(String) });
  expect(activateCall[0]).not.toMatch(/available:|onHand:/);
  expect(mocks.graphql.mock.calls[4][1].input.quantities).toEqual([{ inventoryItemId: "item-1", locationId: "location-1", quantity: 9, changeFromQuantity: 4 }]);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO inventory_snapshots"), ["1146", 10, "location-1", 9, 9, 9, 0]);
});

it("records actual mismatched stock and rejects the job even when the mutation returned success", async () => {
  mocks.graphql.mockResolvedValueOnce(level(0)).mockResolvedValueOnce(level(0))
    .mockResolvedValueOnce(setResult).mockResolvedValueOnce(level(2));
  await expect(syncInventoryNotification(notification, "job-1")).rejects.toBeInstanceOf(RetryableError);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO inventory_snapshots"), ["1146", 10, "location-1", 9, 2, 9, -7]);
  expect(mocks.log).toHaveBeenCalledWith("error", expect.any(String), expect.objectContaining({ inventoryItemId: "item-1", locationId: "location-1", before: 0, expected: 9, after: 2, jobId: "job-1" }));
});

it("rejects multiple enabled branch mappings before any Shopify request", async () => {
  mocks.query.mockResolvedValue([
    { shopify_location_id: "location-1", safety_stock: "0" },
    { shopify_location_id: "location-2", safety_stock: "0" },
  ]);
  await expect(syncInventoryNotification(notification)).rejects.toBeInstanceOf(ConflictError);
  expect(mocks.graphql).not.toHaveBeenCalled();
});

it("does not log activation when the inventory level is already active", async () => {
  mocks.graphql.mockResolvedValueOnce(level(0)).mockResolvedValueOnce(level(0))
    .mockResolvedValueOnce(setResult).mockResolvedValueOnce(level(9));
  await syncInventoryNotification(notification);
  expect(mocks.graphql.mock.calls.some(([document]) => document.includes("inventoryActivate"))).toBe(false);
  expect(mocks.log.mock.calls.some(([, message]) => message.startsWith("inventory_activation_"))).toBe(false);
});

it("logs activation only around an actual mutation", async () => {
  mocks.graphql.mockResolvedValueOnce(level(0, false)).mockResolvedValueOnce(level(0, false))
    .mockResolvedValueOnce(activation).mockResolvedValueOnce(level(4))
    .mockResolvedValueOnce(setResult).mockResolvedValueOnce(level(9));
  await syncInventoryNotification(notification, "job-1");
  for (const action of ["inventory_activation_started", "inventory_activation_completed"])
    expect(mocks.log).toHaveBeenCalledWith("info", action, expect.objectContaining({ sku: "1146", inventoryItemId: "item-1", locationId: "location-1", before: 0, expected: 9, after: null, jobId: "job-1" }));
});

it("makes a stale compare-and-set retryable without a blind overwrite", async () => {
  mocks.graphql.mockResolvedValueOnce(level(0)).mockResolvedValueOnce(level(4))
    .mockResolvedValueOnce({ inventorySetQuantities: { userErrors: [{ code: "CHANGE_FROM_QUANTITY_STALE", field: ["quantities", "0", "changeFromQuantity"], message: "Quantity changed concurrently" }] } });
  await expect(syncInventoryNotification(notification)).rejects.toBeInstanceOf(RetryableError);
  expect(mocks.graphql.mock.calls[2][1].input.quantities[0]).toMatchObject({ quantity: 9, changeFromQuantity: 4 });
  expect(mocks.graphql).toHaveBeenCalledTimes(3);
  expect(mocks.log.mock.calls.some(([, message]) => message === "inventory_set_completed")).toBe(false);
});

it("does not accept an inactive zero level as a verified zero stock update", async () => {
  mocks.graphql.mockResolvedValueOnce(level(0)).mockResolvedValueOnce(level(0)).mockResolvedValueOnce(level(0, false));
  await expect(syncInventoryNotification({ ...notification, OnHand: 0 })).rejects.toThrow("Inventory verification failed");
});

it.each(["activation", "set"])("propagates %s userErrors with code and field", async stage => {
  const errors = [{ message: "Inventory denied", code: "INVALID", field: ["inventoryItemId"] }];
  const before = level(0, stage !== "activation");
  mocks.graphql.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValueOnce(stage === "activation" ? { inventoryActivate: { inventoryLevel: null, userErrors: errors } } : { inventorySetQuantities: { userErrors: errors } });
  await expect(syncInventoryNotification(notification)).rejects.toThrow("INVALID");
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO inventory_snapshots"))).toBe(false);
});

it("identifies required inventory scopes on authentication failure", async () => {
  mocks.graphql.mockRejectedValue(new AuthenticationError("Shopify authentication failed (403)"));
  await expect(ensureShopifyInventoryActive("item-1", "location-1")).rejects.toThrow("write_inventory");
});

it("rejects a missing item instead of treating it as zero stock", async () => {
  mocks.graphql.mockResolvedValue({ inventoryItem: null });
  await expect(getShopifyInventory("item-1", "location-1")).rejects.toThrow("does not exist");
});

it("uses each enabled branch mapping and its safety stock independently", async () => {
  mocks.query.mockImplementation(async (sql: string, values: unknown[]) => sql.includes("FROM branch_location_mappings") ? [{ shopify_location_id: `location-${values[0]}`, safety_stock: values[0] === 10 ? "2" : "3" }] : []);
  const states = new Map<string, number>();
  mocks.graphql.mockImplementation(async (document: string, variables: Record<string, unknown>) => {
    if (document.includes("query Inventory")) return level(states.get(String(variables.location)) ?? 0);
    const input = variables.input as { quantities: Array<{ locationId: string; quantity: number }> };
    const quantity = input.quantities[0]; states.set(quantity.locationId, quantity.quantity); return setResult;
  });
  await syncInventoryNotification(notification);
  await syncInventoryNotification({ ...notification, BranchId: 20, OnHand: 12 });
  expect([...states]).toEqual([["location-10", 7], ["location-20", 9]]);
  expect(mocks.query.mock.calls[0][0]).toContain("enabled=true");
});
