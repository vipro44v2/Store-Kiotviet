import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { InvoiceAutomationStatus } from "@/components/admin/invoice-automation-status";

const orders = { invoiceCreationTrigger: "shopify_fulfilled", productOnlyInvoicing: true, allowUnverifiedPrepaymentInheritance: true,
  acknowledgeUnverifiedPrepaymentRisk: true, unverifiedPrepaymentAcceptedBy: "kt-admin", unverifiedPrepaymentAcceptedAt: "2026-11-05T02:00:00.000Z" };

it("shows trigger, policies, index health, status counts and latency", () => {
  const html = renderToStaticMarkup(createElement(InvoiceAutomationStatus, {
    orders,
    index: { scanned: 13_200, total: 13_215, lag: 15, currentAsOf: new Date("2026-11-05T02:00:00Z"), usable: true, stale: false, lastError: null, generation: 1 },
    stats: {
      counts: { pending: 1, processing: 0, created: 40, blocked: 3, needs_review: 2, failed: 0, payment_verified: 39, payment_mismatch: 1, stock_unsynced: 0 },
      latency: { samples: 40, avgMs: 12_400, p95Ms: 41_000, within60s: 39 },
      lookup: { samples: 80, localP95Ms: 3.4, refreshP95Ms: 900, totalP50Ms: 310, totalAvgMs: 420, totalP95Ms: 1_300, apiCallsAvg: 0.7, shared: 40 },
    },
  }));
  for (const text of ["shopify_fulfilled", "Bật", "Cho phép chưa xác minh", "kt-admin", "13200/13215", "dùng được",
    "pending 1", "created 40", "blocked 3", "needs_review 2", "khớp 39", "lệch 1", "trung bình 12.4 s", "P95 41.0 s", "≤ 60 s: 98% của 40", "PostgreSQL P95 3.4 ms", "làm mới chỉ mục P95 900 ms", "tổng P50 310 ms", "trung bình 420 ms", "P95 1.3 s", "0.7 request KiotViet/lần", "dùng chung xác nhận 50% của 80"])
    expect(html).toContain(text);
});

it("reports strict mode and missing data without failing", () => {
  const html = renderToStaticMarkup(createElement(InvoiceAutomationStatus, { orders: undefined, index: null, stats: null }));
  expect(html).toContain("Strict (không áp dụng)");
  expect(html).toContain("chưa có dữ liệu");
});
