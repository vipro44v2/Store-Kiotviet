import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ appInvoice: false, status: "created", fulfill: vi.fn(), cancel: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
  transaction: (callback: (client: unknown) => Promise<unknown>) => callback({
    query: async (sql: string) => {
      if (sql.includes("FROM invoice_mappings")) return { rows: mocks.appInvoice ? [{}] : [] };
      if (sql.includes("FROM order_mappings WHERE kiotviet_order_code"))
        return { rows: [{ shopify_order_id: "5001", kiotviet_order_id: "700" }], rowCount: 1 };
      if (sql.includes("FROM order_mappings WHERE kiotviet_order_id"))
        return { rows: [{ shopify_order_id: "5001", status: mocks.status, kiotviet_order_code: "DH700" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  }),
}));
vi.mock("@/lib/shopify/orders", () => ({ fulfillShopifyOrderById: mocks.fulfill, cancelShopifyOrderById: mocks.cancel }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));

import { syncKiotVietInvoice, syncKiotVietOrderStatus } from "@/lib/sync/order-sync";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appInvoice = false;
  mocks.status = "created";
  mocks.fulfill.mockResolvedValue({ fulfilled: true });
});

describe("KiotViet invoices created by this app do not fulfill Shopify orders", () => {
  it("does not fulfill when the KiotViet order completes because the app invoiced it", async () => {
    mocks.appInvoice = true;
    await expect(syncKiotVietOrderStatus({ Id: 700, Status: 3 })).resolves.toEqual({ updated: false, reason: "completed_by_app_invoice" });
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });

  it("does not fulfill on invoice.update for an app invoice without tracking", async () => {
    mocks.appInvoice = true;
    await expect(syncKiotVietInvoice({ Id: 9001, OrderCode: "DH700" })).resolves.toEqual({ fulfilled: false, reason: "invoice_created_by_sync_app" });
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });

  it("still fulfills when staff add a delivery tracking number", async () => {
    mocks.appInvoice = true;
    await syncKiotVietInvoice({ Id: 9001, OrderCode: "DH700", InvoiceDelivery: { DeliveryCode: "GHN123" } });
    expect(mocks.fulfill).toHaveBeenCalledWith("5001", "DH700", { number: "GHN123", company: undefined });
  });

  it("keeps the existing behavior for invoices staff create in KiotViet", async () => {
    await syncKiotVietOrderStatus({ Id: 700, Status: 3 });
    await syncKiotVietInvoice({ Id: 9001, OrderCode: "DH700" });
    expect(mocks.fulfill).toHaveBeenCalledTimes(2);
  });

  it("still cancels the Shopify order when the KiotViet order is cancelled", async () => {
    mocks.appInvoice = true;
    await syncKiotVietOrderStatus({ Id: 700, Status: 4 });
    expect(mocks.cancel).toHaveBeenCalledWith("5001", "DH700");
  });
});
