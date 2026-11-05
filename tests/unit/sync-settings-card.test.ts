import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SyncSettingsCard } from "@/components/admin/sync-settings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it("renders each sync direction with Vietnamese labels and the stored values", () => {
  const html = renderToStaticMarkup(createElement(SyncSettingsCard, {
    stored: {
      shopifyOrdersToKiotViet: true,
      kiotVietOrderStatusToShopify: false,
      kiotVietInventoryToShopify: true,
      shopifyOrderCancellationsToKiotViet: true,
      inventoryConflictStrategy: "hold",
    },
    orders: { syncCustomers: false },
  }));
  expect(html).toContain("Đồng bộ đơn hàng Shopify → KiotViet");
  expect(html).toContain("Đồng bộ trạng thái đơn KiotViet → Shopify");
  expect(html).toContain("Đồng bộ tồn kho KiotViet → Shopify");
  expect(html).toContain("Đồng bộ khách hàng Shopify → KiotViet");
  expect(html).toContain("Invoice Creation Trigger");
  expect(html).toContain("Tiền tệ của giá trên KiotViet");
  // orders, cancellations and inventory are on; reverse status and customers are off.
  expect(html.match(/checked=""/g)).toHaveLength(3);
  expect(html).not.toContain("migration 006");
});

it("explains the legacy fallback before migration 006 has run", () => {
  const html = renderToStaticMarkup(createElement(SyncSettingsCard, { stored: undefined, orders: undefined }));
  expect(html).toContain("migration 006");
  expect(html.match(/checked=""/g)).toHaveLength(5);
});

it("shows Product-Only Invoicing off by default and its options once selected", () => {
  const off = renderToStaticMarkup(createElement(SyncSettingsCard, { stored: undefined, orders: { invoiceCreationTrigger: "shopify_paid" } }));
  expect(off).toContain("Product-Only Invoicing");
  expect(off).not.toContain("excludeShipping");
  const on = renderToStaticMarkup(createElement(SyncSettingsCard, {
    stored: undefined, orders: { invoiceCreationTrigger: "shopify_paid", productOnlyInvoicing: true, excludeShipping: false },
  }));
  for (const key of ["excludeShipping", "excludeProcessingFees", "excludeOtherSurcharges", "ignoreFinancialMismatch", "Shopify (paymentSource)"])
    expect(on).toContain(key);
  // 5 sync/customer flags + the mode + 3 exclusions that default on (excludeShipping was turned off).
  expect(on.match(/checked=""/g)).toHaveLength(9);
});

it("offers Allow Unverified Prepayment Inheritance only in Product-Only mode, with the risk confirmation", () => {
  const strict = renderToStaticMarkup(createElement(SyncSettingsCard, { stored: undefined, orders: { invoiceCreationTrigger: "shopify_fulfilled" } }));
  expect(strict).not.toContain("Allow Unverified Prepayment Inheritance");
  const enabled = renderToStaticMarkup(createElement(SyncSettingsCard, { stored: undefined, orders: {
    invoiceCreationTrigger: "shopify_fulfilled", productOnlyInvoicing: true, allowUnverifiedPrepaymentInheritance: true,
    acknowledgeUnverifiedPrepaymentRisk: true, unverifiedPrepaymentAcceptedBy: "kt-admin", unverifiedPrepaymentAcceptedAt: "2026-11-05T02:00:00.000Z",
  } }));
  expect(enabled).toContain("Allow Unverified Prepayment Inheritance");
  expect(enabled).toContain("No additional payment is submitted. Invoices with payment discrepancies are marked Needs Review.");
  expect(enabled).toContain("Tôi hiểu rủi ro kế toán");
  expect(enabled).toContain("Đã bật bởi kt-admin");
  expect(enabled).toContain("Chặn (mặc định)");
});
