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
