import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { SyncJobPayload } from "@/lib/queue/jobs";
import {
  DEFAULT_SYNC_SETTINGS,
  disabledSyncForJob,
  LEGACY_SYNC_SETTINGS,
  parseSyncSettings,
  synchronizationSettingsSchema,
  type SynchronizationSettings,
} from "@/lib/settings/sync-settings";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  get: vi.fn(),
  processed: vi.fn(),
  ignored: vi.fn(),
  log: vi.fn(),
  syncOrder: vi.fn(),
  cancelOrder: vi.fn(),
  orderStatus: vi.fn(),
  invoice: vi.fn(),
  inventory: vi.fn(),
  page: vi.fn(),
  admit: vi.fn(),
}));
vi.mock("@/lib/sync/sync-settings", () => ({
  getSyncSettings: async () => mocks.settings,
}));
vi.mock("@/repositories/webhooks", () => ({
  webhooksRepository: { get: mocks.get, markProcessed: mocks.processed, markIgnored: mocks.ignored },
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/sync/order-sync", () => ({
  syncShopifyOrder: mocks.syncOrder,
  cancelShopifyOrder: mocks.cancelOrder,
  syncKiotVietOrderCancellation: mocks.orderStatus,
  syncKiotVietInvoice: mocks.invoice,
}));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: mocks.inventory }));
vi.mock("@/lib/sync/reconciliation", () => ({ reconcileInventoryPage: mocks.page, cleanupOldData: vi.fn() }));
vi.mock("@/repositories/inventory-reconciliation", () => ({ admitInventoryReconciliation: mocks.admit }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ JOB_MAX_ATTEMPTS: 5 }) }));

import { processSyncJob } from "@/lib/queue/worker";

const job = (name: string, data: SyncJobPayload = {}) =>
  ({ name, data: { auditJobId: "audit-1", ...data } }) as unknown as Job<SyncJobPayload>;
const use = (overrides: Partial<SynchronizationSettings>) => {
  mocks.settings = { ...DEFAULT_SYNC_SETTINGS, ...overrides };
};
const stockEvent = {
  payload: { Notifications: [{ Action: "stock.update", Data: [{ ProductId: 1, ProductCode: "SKU-1", BranchId: 10, OnHand: 5, Reserved: 0 }] }] },
};
const kiotVietOrderEvent = {
  payload: { Notifications: [{ Action: "order.update", Data: [{ Id: 24102572, Status: 4 }] }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  use({});
  mocks.admit.mockResolvedValue({ deduplicated: false, payload: { reconciliationChainId: "chain" } });
});

describe("sync settings parsing", () => {
  it("uses the documented defaults for new installations", () => {
    expect(DEFAULT_SYNC_SETTINGS).toEqual({
      shopifyOrdersToKiotViet: true,
      kiotVietOrderStatusToShopify: false,
      kiotVietInventoryToShopify: true,
      shopifyOrderCancellationsToKiotViet: true,
      inventoryConflictStrategy: "hold",
    });
  });
  it("keeps legacy behavior when the settings row does not exist yet", () => {
    expect(parseSyncSettings(undefined)).toEqual(LEGACY_SYNC_SETTINGS);
    expect(LEGACY_SYNC_SETTINGS.kiotVietOrderStatusToShopify).toBe(true);
  });
  it("fills missing or malformed fields from the defaults and keeps stored values", () => {
    expect(parseSyncSettings({ kiotVietInventoryToShopify: false, shopifyOrdersToKiotViet: "yes" })).toEqual({
      ...DEFAULT_SYNC_SETTINGS,
      kiotVietInventoryToShopify: false,
    });
  });
  it("rejects unknown keys and non-boolean values on save", () => {
    expect(() => synchronizationSettingsSchema.parse({ ...DEFAULT_SYNC_SETTINGS, extra: true })).toThrow();
    expect(() => synchronizationSettingsSchema.parse({ ...DEFAULT_SYNC_SETTINGS, kiotVietInventoryToShopify: "false" })).toThrow();
  });
  it("gates each direction independently", () => {
    const off = { ...DEFAULT_SYNC_SETTINGS, shopifyOrdersToKiotViet: false, kiotVietOrderStatusToShopify: false };
    expect(disabledSyncForJob("shopify_order_create", off)?.setting).toBe("shopifyOrdersToKiotViet");
    expect(disabledSyncForJob("shopify_order_cancel", off)?.setting).toBe("shopifyOrdersToKiotViet");
    expect(disabledSyncForJob("kiotviet_invoice_to_shopify", off)?.setting).toBe("kiotVietOrderStatusToShopify");
    expect(disabledSyncForJob("kiotviet_inventory_to_shopify", off)).toBeUndefined();
    expect(disabledSyncForJob("inventory_reconciliation", off)).toBeUndefined();
    expect(disabledSyncForJob("shopify_customer_to_kiotviet", off)).toBeUndefined();
    expect(disabledSyncForJob("shopify_order_cancel", { ...DEFAULT_SYNC_SETTINGS, shopifyOrderCancellationsToKiotViet: false })?.setting)
      .toBe("shopifyOrderCancellationsToKiotViet");
  });
});

describe("worker gating", () => {
  it.each(["shopify_order_create", "shopify_order_update", "shopify_order_cancel"])(
    "skips %s without touching KiotViet when Shopify order sync is disabled",
    async (name) => {
      use({ shopifyOrdersToKiotViet: false });
      await expect(processSyncJob(job(name, { eventId: "evt-1" }))).resolves.toEqual({
        skipped: true, reason: "shopify_orders_to_kiotviet_disabled",
      });
      expect(mocks.syncOrder).not.toHaveBeenCalled();
      expect(mocks.cancelOrder).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.ignored).toHaveBeenCalledWith("evt-1", "shopify_orders_to_kiotviet_disabled");
      expect(mocks.processed).not.toHaveBeenCalled();
      expect(mocks.log).toHaveBeenCalledWith("info", expect.any(String), expect.objectContaining({
        action: "sync_direction_disabled", jobType: name, eventId: "evt-1",
      }));
    },
  );

  it("passes job context to order sync when enabled", async () => {
    mocks.get.mockResolvedValue({ payload: { id: 1, line_items: [] } });
    await expect(processSyncJob(job("shopify_order_update", { eventId: "evt-1" }))).resolves.toBeUndefined();
    expect(mocks.syncOrder).toHaveBeenCalledWith({ id: 1, line_items: [] }, {
      jobType: "shopify_order_update", eventId: "evt-1", jobId: "audit-1",
    });
    expect(mocks.processed).toHaveBeenCalledWith("evt-1");
  });

  it("rejects an order job whose webhook event no longer exists as manual review", async () => {
    mocks.get.mockResolvedValue(undefined);
    await expect(processSyncJob(job("shopify_order_update", { eventId: "gone" }))).rejects.toThrow("no longer exists");
    expect(mocks.syncOrder).not.toHaveBeenCalled();
  });

  it.each(["kiotviet_order_to_shopify", "kiotviet_invoice_to_shopify"])(
    "never cancels or fulfills Shopify orders from %s when reverse order status sync is disabled",
    async (name) => {
      use({ kiotVietOrderStatusToShopify: false });
      mocks.get.mockResolvedValue(kiotVietOrderEvent);
      await expect(processSyncJob(job(name, { eventId: "evt-2" }))).resolves.toMatchObject({ skipped: true });
      expect(mocks.orderStatus).not.toHaveBeenCalled();
      expect(mocks.invoice).not.toHaveBeenCalled();
      expect(mocks.ignored).toHaveBeenCalledWith("evt-2", "kiotviet_order_status_to_shopify_disabled");
    },
  );

  it("skips a manual tracking job (invoiceId) when reverse order status sync is disabled", async () => {
    use({ kiotVietOrderStatusToShopify: false });
    await expect(processSyncJob(job("kiotviet_invoice_to_shopify", { invoiceId: 5 }))).resolves.toMatchObject({ skipped: true });
    expect(mocks.invoice).not.toHaveBeenCalled();
  });

  it("processes KiotViet order status events when enabled", async () => {
    use({ kiotVietOrderStatusToShopify: true });
    mocks.get.mockResolvedValue(kiotVietOrderEvent);
    await processSyncJob(job("kiotviet_order_to_shopify", { eventId: "evt-2" }));
    expect(mocks.orderStatus).toHaveBeenCalledWith({ Id: 24102572, Status: 4 });
  });

  it("synchronizes inventory while order sync is disabled", async () => {
    use({ shopifyOrdersToKiotViet: false, kiotVietOrderStatusToShopify: false });
    mocks.get.mockResolvedValue(stockEvent);
    await expect(processSyncJob(job("kiotviet_inventory_to_shopify", { eventId: "evt-3" }))).resolves.toBeUndefined();
    expect(mocks.inventory).toHaveBeenCalledWith(
      expect.objectContaining({ ProductCode: "SKU-1", OnHand: 5 }), "audit-1", { conflictStrategy: "hold" },
    );
    expect(mocks.processed).toHaveBeenCalledWith("evt-3");
  });

  it("keeps scheduled reconciliation running while order jobs fail", async () => {
    mocks.get.mockResolvedValue({ payload: { id: 1, line_items: [] } });
    mocks.syncOrder.mockRejectedValue(new TypeError("Cannot read properties of null (reading 'trim')"));
    await expect(processSyncJob(job("shopify_order_update", { eventId: "evt-4" }))).rejects.toThrow(TypeError);
    await expect(processSyncJob(job("inventory_reconciliation"))).resolves.toBeUndefined();
    expect(mocks.page).toHaveBeenCalledWith(0, "audit-1", "chain", { conflictStrategy: "hold" });
  });

  it("does not write Shopify inventory when inventory sync is disabled, without failing the job", async () => {
    use({ kiotVietInventoryToShopify: false });
    mocks.get.mockResolvedValue(stockEvent);
    await expect(processSyncJob(job("kiotviet_inventory_to_shopify", { eventId: "evt-5" }))).resolves.toEqual({
      skipped: true, reason: "kiotviet_inventory_to_shopify_disabled",
    });
    await expect(processSyncJob(job("inventory_reconciliation"))).resolves.toMatchObject({ skipped: true });
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("passes the legacy overwrite strategy through when selected", async () => {
    use({ inventoryConflictStrategy: "kiotviet_wins" });
    mocks.get.mockResolvedValue(stockEvent);
    await processSyncJob(job("kiotviet_inventory_to_shopify", { eventId: "evt-6" }));
    expect(mocks.inventory).toHaveBeenCalledWith(expect.anything(), "audit-1", { conflictStrategy: "kiotviet_wins" });
  });
});
