import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KiotVietStockNotification } from "@/lib/kiotviet/types";

const mocks = vi.hoisted(() => ({
  findBySku: vi.fn(),
  query: vi.fn(),
  getActiveLocations: vi.fn(),
  available: 0,
  setInventory: vi.fn(),
  log: vi.fn(),
  lastSynced: null as string | null,
  kiotVietOnHand: 0,
  locations: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/repositories/mappings", () => ({ mappingsRepository: { findBySku: mocks.findBySku } }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/shopify/locations", () => ({ getActiveShopifyLocations: mocks.getActiveLocations }));
vi.mock("@/lib/shopify/inventory", () => ({
  getShopifyInventory: async () => ({ isActive: true, available: mocks.available, onHand: mocks.available }),
  ensureShopifyInventoryActive: async () => ({ isActive: true, available: mocks.available, onHand: mocks.available }),
  setShopifyInventory: mocks.setInventory,
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/kiotviet/products", () => ({
  getKiotVietProduct: async (id: number) => ({ id, inventories: [{ branchId: 10, onHand: mocks.kiotVietOnHand, reserved: 0 }] }),
}));

import {
  detectUnreflectedShopifyDeduction,
  SHOPIFY_DEDUCTION_CONFLICT,
  syncInventoryNotification,
} from "@/lib/sync/inventory-sync";
import { MappingError } from "@/lib/errors";

const notification: KiotVietStockNotification = {
  ProductId: 1, ProductCode: "SKU-1", ProductName: "Product", BranchId: 10,
  BranchName: "Main", Cost: 0, OnHand: 10, Reserved: 1,
};
const sqlCalls = (fragment: string) =>
  mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lastSynced = null;
  mocks.locations = [{ shopify_location_id: "location-1", safety_stock: "0" }];
  mocks.findBySku.mockResolvedValue([{ kiotviet_product_id: "1", shopify_inventory_item_id: "item-1" }]);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM branch_location_mappings")) return mocks.locations;
    if (sql.includes("FROM inventory_snapshots")) return mocks.lastSynced === null ? [] : [{ shopify_quantity: mocks.lastSynced }];
    return [];
  });
  mocks.setInventory.mockImplementation(async (_item, _location, quantity) => { mocks.available = quantity; return {}; });
});

describe("detectUnreflectedShopifyDeduction", () => {
  it.each([
    [null, 9, 10, false, "no baseline yet (first sync)"],
    [10, 10, 12, false, "Shopify unchanged; KiotViet restock"],
    [10, 11, 10, false, "Shopify increased (e.g. restocked cancellation)"],
    [10, 9, 9, false, "KiotViet already reflects the sale"],
    [10, 9, 8, false, "KiotViet lower than Shopify (another sale in store)"],
    [10, 9, 10, true, "stale KiotViet quantity would restore the sale"],
    [10, 8, 9, true, "KiotViet reflects only part of the deductions"],
    [10, 9, 30, true, "restock while a sale is unreflected"],
  ] as Array<[number | null, number, number, boolean, string]>)("lastSynced=%s current=%s expected=%s → %s (%s)", (last, current, expected, flagged) => {
    expect(detectUnreflectedShopifyDeduction(last, current, expected) !== null).toBe(flagged);
  });
});

describe("Shopify sales not reflected in KiotViet", () => {
  it("holds the write, keeps the Shopify quantity and flags one conflict", async () => {
    mocks.lastSynced = "10";
    mocks.available = 9; // one unit sold on Shopify; KiotViet OnHand still 10
    await expect(syncInventoryNotification(notification, "job-1")).resolves.toMatchObject({
      status: "held", lastSynced: 10, currentShopify: 9, expected: 10, wouldRestore: 1,
    });
    expect(mocks.setInventory).not.toHaveBeenCalled();
    const [conflict] = sqlCalls("INSERT INTO sync_conflicts");
    expect(conflict[0]).toContain("WHERE NOT EXISTS");
    expect(conflict[1].slice(0, 2)).toEqual(["SKU-1@location-1", SHOPIFY_DEDUCTION_CONFLICT]);
    expect(JSON.parse(conflict[1][2])).toMatchObject({ sku: "SKU-1", locationId: "location-1", available: 9, lastSynced: 10 });
    expect(JSON.parse(conflict[1][3])).toMatchObject({ branchId: 10, onHand: 10, expected: 10, strategy: "hold" });
    const [held] = sqlCalls("INSERT INTO inventory_snapshots");
    expect(held[0]).toContain("'held'");
    expect(held[1]).toEqual(["SKU-1", 10, "location-1", 10, 9, 10, -1]);
    expect(mocks.log).toHaveBeenCalledWith("warn", expect.any(String), expect.objectContaining({ action: "inventory_shopify_deduction_detected" }));
  });

  it("still lowers Shopify when KiotViet is lower (decreases are never held)", async () => {
    mocks.lastSynced = "10";
    mocks.available = 9;
    await expect(syncInventoryNotification({ ...notification, OnHand: 7 })).resolves.toEqual({ status: "synced" });
    expect(mocks.setInventory).toHaveBeenCalledWith("item-1", "location-1", 7, 9);
    expect(sqlCalls("INSERT INTO sync_conflicts")).toHaveLength(0);
  });

  it("auto-resolves the held conflict once KiotViet reflects the sale", async () => {
    mocks.lastSynced = "10";
    mocks.available = 9;
    await syncInventoryNotification({ ...notification, OnHand: 9 });
    expect(mocks.setInventory).not.toHaveBeenCalled();
    const [resolved] = sqlCalls("UPDATE sync_conflicts SET resolution_status='resolved'");
    expect(resolved[1].slice(0, 2)).toEqual(["SKU-1@location-1", SHOPIFY_DEDUCTION_CONFLICT]);
    // The verified snapshot (status NULL) becomes the next baseline.
    expect(sqlCalls("INSERT INTO inventory_snapshots")[0][1]).toEqual(["SKU-1", 10, "location-1", 9, 9, 9, 0]);
  });

  it("overwrites with KiotViet but still flags the discrepancy under kiotviet_wins", async () => {
    mocks.lastSynced = "10";
    mocks.available = 9;
    await expect(syncInventoryNotification(notification, "job-1", { conflictStrategy: "kiotviet_wins" }))
      .resolves.toEqual({ status: "synced" });
    expect(mocks.setInventory).toHaveBeenCalledWith("item-1", "location-1", 10, 9);
    expect(sqlCalls("INSERT INTO sync_conflicts")).toHaveLength(1);
  });

  it("keeps the existing absolute sync (compare-and-set) when no baseline exists", async () => {
    mocks.available = 3;
    await syncInventoryNotification(notification);
    expect(mocks.setInventory).toHaveBeenCalledWith("item-1", "location-1", 10, 3);
    expect(sqlCalls("INSERT INTO sync_conflicts")).toHaveLength(0);
  });

  it("reads the baseline only from verified or operator-accepted snapshots", async () => {
    mocks.available = 3;
    await syncInventoryNotification(notification);
    const [baseline] = sqlCalls("FROM inventory_snapshots");
    expect(baseline[0]).toContain("(status IS NULL OR status='baseline')");
    expect(baseline[0]).toContain("shopify_quantity=expected_shopify_quantity");
    expect(baseline[1]).toEqual(["SKU-1", "location-1"]);
  });
});

describe("inventory mapping failures", () => {
  it("fails a missing product mapping without writing Shopify inventory", async () => {
    mocks.findBySku.mockResolvedValue([]);
    await expect(syncInventoryNotification(notification)).rejects.toBeInstanceOf(MappingError);
    expect(mocks.setInventory).not.toHaveBeenCalled();
  });

  it("fails a missing branch/location mapping when it cannot be inferred", async () => {
    mocks.locations = [];
    mocks.getActiveLocations.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await expect(syncInventoryNotification(notification)).rejects.toThrow("must be mapped manually");
    expect(mocks.setInventory).not.toHaveBeenCalled();
  });
});

describe("KiotViet invoices and Shopify sales (no double deduction)", () => {
  it("does not subtract the sold quantity again when the invoice lowers KiotViet stock", async () => {
    mocks.lastSynced = "10";
    mocks.available = 9; // Shopify already deducted the order (10 → 9)
    mocks.kiotVietOnHand = 9; // the KiotViet invoice deducted the same unit (10 → 9)
    await expect(syncInventoryNotification({ ...notification, OnHand: 9 }, "job", { refreshFromKiotViet: true }))
      .resolves.toEqual({ status: "synced" });
    expect(mocks.setInventory).not.toHaveBeenCalled();
    expect(mocks.available).toBe(9);
    expect(sqlCalls("UPDATE sync_conflicts SET resolution_status='resolved'")).toHaveLength(1);
  });

  it("ignores a stale higher stock event that arrives after the invoice (out of order)", async () => {
    mocks.lastSynced = "9";
    mocks.available = 9;
    mocks.kiotVietOnHand = 9;
    await syncInventoryNotification({ ...notification, OnHand: 10 }, "job", { refreshFromKiotViet: true });
    expect(mocks.setInventory).not.toHaveBeenCalled();
    expect(sqlCalls("INSERT INTO sync_conflicts")).toHaveLength(0);
    expect(mocks.log).toHaveBeenCalledWith("info", expect.any(String), expect.objectContaining({ action: "inventory_event_superseded", eventOnHand: 10, currentOnHand: 9 }));
  });

  it("ignores a stale lower stock event and keeps the current absolute KiotViet value", async () => {
    mocks.lastSynced = "9";
    mocks.available = 9;
    mocks.kiotVietOnHand = 9;
    await syncInventoryNotification({ ...notification, OnHand: 7 }, "job", { refreshFromKiotViet: true });
    expect(mocks.setInventory).not.toHaveBeenCalled();
  });

  it("applies the current KiotViet value with compare-and-set and verifies it by readback", async () => {
    mocks.lastSynced = "12";
    mocks.available = 12;
    mocks.kiotVietOnHand = 9; // in-store sale and invoice reduced KiotViet
    await syncInventoryNotification({ ...notification, OnHand: 11 }, "job", { refreshFromKiotViet: true });
    expect(mocks.setInventory).toHaveBeenCalledWith("item-1", "location-1", 9, 12);
    expect(sqlCalls("INSERT INTO inventory_snapshots")[0][1]).toEqual(["SKU-1", 10, "location-1", 9, 9, 9, 0]);
  });
});
