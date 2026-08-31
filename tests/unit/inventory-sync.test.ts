import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KiotVietStockNotification } from "@/lib/kiotviet/types";

const mocks = vi.hoisted(() => ({
  findBySku: vi.fn(),
  query: vi.fn(),
  getActiveLocations: vi.fn(),
  getInventory: vi.fn(),
  setInventory: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/repositories/mappings", () => ({
  mappingsRepository: { findBySku: mocks.findBySku },
}));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/shopify/locations", () => ({
  getActiveShopifyLocations: mocks.getActiveLocations,
}));
vi.mock("@/lib/shopify/inventory", () => ({
  getShopifyInventory: mocks.getInventory,
  setShopifyInventory: mocks.setInventory,
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { syncInventoryNotification } from "@/lib/sync/inventory-sync";

const notification: KiotVietStockNotification = {
  ProductId: 1,
  ProductCode: "SKU-1",
  ProductName: "Product",
  BranchId: 10,
  BranchName: "Main branch",
  Cost: 0,
  OnHand: 10,
  Reserved: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findBySku.mockResolvedValue([
    { shopify_inventory_item_id: "gid://shopify/InventoryItem/1" },
  ]);
  mocks.getInventory.mockResolvedValue(3);
  mocks.setInventory.mockResolvedValue({});
  mocks.log.mockResolvedValue(undefined);
});

describe("syncInventoryNotification", () => {
  it("uses an existing mapping", async () => {
    mocks.query
      .mockResolvedValueOnce([
        { shopify_location_id: "location-1", safety_stock: "1" },
      ])
      .mockResolvedValueOnce([]);

    await syncInventoryNotification(notification);

    expect(mocks.getActiveLocations).not.toHaveBeenCalled();
    expect(mocks.setInventory).toHaveBeenCalledWith(
      "gid://shopify/InventoryItem/1",
      "location-1",
      7,
      3,
    );
  });

  it("automatically maps one active location and syncs inventory", async () => {
    mocks.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { shopify_location_id: "location-1", safety_stock: "0", created: true },
      ])
      .mockResolvedValueOnce([]);
    mocks.getActiveLocations.mockResolvedValue([
      { id: "location-1", name: "Primary" },
    ]);

    await syncInventoryNotification(notification);

    expect(mocks.query.mock.calls[1][0]).toContain("ON CONFLICT");
    expect(mocks.query.mock.calls[1][1]).toEqual([
      10,
      "Main branch",
      "location-1",
      "Primary",
    ]);
    expect(mocks.setInventory).toHaveBeenCalledWith(
      "gid://shopify/InventoryItem/1",
      "location-1",
      8,
      3,
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "info",
      "Automatic branch/location mapping created",
      expect.any(Object),
    );
  });

  it("fails safely when multiple active locations exist", async () => {
    mocks.query.mockResolvedValueOnce([]);
    mocks.getActiveLocations.mockResolvedValue([
      { id: "location-1", name: "Primary" },
      { id: "location-2", name: "Secondary" },
    ]);

    await expect(syncInventoryNotification(notification)).rejects.toThrow(
      "must be mapped manually",
    );
    expect(mocks.setInventory).not.toHaveBeenCalled();
  });

  it("fails clearly when no active locations exist", async () => {
    mocks.query.mockResolvedValueOnce([]);
    mocks.getActiveLocations.mockResolvedValue([]);

    await expect(syncInventoryNotification(notification)).rejects.toThrow(
      "No active Shopify locations exist",
    );
    expect(mocks.setInventory).not.toHaveBeenCalled();
  });

  it("uses an idempotent upsert for concurrent webhooks", async () => {
    const rows: Array<{ shopify_location_id: string; safety_stock: string }> = [];
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT shopify_location_id")) return [];
      if (sql.includes("INSERT INTO branch_location_mappings")) {
        if (!rows.length)
          rows.push({ shopify_location_id: "location-1", safety_stock: "0" });
        return rows.map((row, index) => ({ ...row, created: index === 0 }));
      }
      return [];
    });
    mocks.getActiveLocations.mockResolvedValue([
      { id: "location-1", name: "Primary" },
    ]);

    await Promise.all([
      syncInventoryNotification(notification),
      syncInventoryNotification(notification),
    ]);

    expect(rows).toHaveLength(1);
    expect(
      mocks.query.mock.calls.filter(([sql]) =>
        String(sql).includes("ON CONFLICT(kiotviet_branch_id,shopify_location_id)"),
      ),
    ).toHaveLength(2);
  });

  it("clamps negative calculated inventory to zero", async () => {
    mocks.query
      .mockResolvedValueOnce([
        { shopify_location_id: "location-1", safety_stock: "3" },
      ])
      .mockResolvedValueOnce([]);
    mocks.getInventory.mockResolvedValue(4);

    await syncInventoryNotification({
      ...notification,
      OnHand: 1,
      Reserved: 2,
    });

    expect(mocks.setInventory).toHaveBeenCalledWith(
      "gid://shopify/InventoryItem/1",
      "location-1",
      0,
      4,
    );
  });
});
