import type { InvoiceIndexHealth } from "@/lib/kiotviet/invoice-index";
import { productOnlyPolicy } from "@/lib/sync/product-only-invoicing";
import type { invoicesRepository } from "@/repositories/invoices";

export type InvoiceAutomationStats = Awaited<ReturnType<typeof invoicesRepository.automationStats>>;

const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const ms = (value: number | null) => (value === null ? "—" : value < 1000 ? `${value} ms` : seconds(value));

/** Read-only overview of automatic invoicing (Admin → Settings and Admin → Hóa đơn). */
export function InvoiceAutomationStatus({ orders, index, stats }: {
  orders: Record<string, unknown> | undefined;
  index: InvoiceIndexHealth | null;
  stats: InvoiceAutomationStats | null;
}) {
  const policy = productOnlyPolicy(orders ?? {});
  const prepayment = !policy.enabled ? "Strict (không áp dụng)"
    : policy.allowUnverifiedPrepaymentInheritance
      ? `Cho phép chưa xác minh — kiểm tra sau khi tạo (xác nhận bởi ${String(orders?.unverifiedPrepaymentAcceptedBy ?? "?")} lúc ${String(orders?.unverifiedPrepaymentAcceptedAt ?? "?")})`
      : "Bắt buộc bằng chứng sandbox + kế toán xác nhận";
  const counts = stats?.counts ?? {};
  const latency = stats?.latency;
  const lookup = stats?.lookup;
  return (
    <section className="setting-card">
      <h2>Tự động tạo hóa đơn</h2>
      <dl>
        <dt>Invoice trigger</dt><dd>{String(orders?.invoiceCreationTrigger ?? "legacy / chưa chọn")}</dd>
        <dt>Product-Only</dt><dd>{policy.enabled ? "Bật" : "Tắt"}</dd>
        <dt>Prepayment verification policy</dt><dd>{prepayment}</dd>
        <dt>Prepayment &gt; hóa đơn (ví dụ #1071)</dt><dd>{policy.prepaymentExceedsInvoicePolicy === "manual_override" ? "Chỉ ghi đè thủ công từng đơn" : "Chặn"}</dd>
        <dt>Invoice Index</dt>
        <dd>
          {index
            ? `${index.scanned}/${index.total ?? "?"} (chậm ${index.lag ?? "?"}) · ${index.usable ? "dùng được" : "đang xây dựng lại"}${index.stale ? " · CŨ" : ""} · cập nhật ${index.currentAsOf?.toISOString() ?? "chưa bao giờ"}`
            : "—"}
        </dd>
        <dt>Trạng thái</dt>
        <dd>
          pending {counts.pending ?? 0} · processing {counts.processing ?? 0} · created {counts.created ?? 0} · blocked {counts.blocked ?? 0} ·
          {" "}needs_review {counts.needs_review ?? 0} · failed {counts.failed ?? 0}
        </dd>
        <dt>Thanh toán sau khi tạo</dt>
        <dd>khớp {counts.payment_verified ?? 0} · lệch {counts.payment_mismatch ?? 0} · chưa xác minh {counts.payment_unverified ?? 0} · tồn kho Shopify chưa đồng bộ {counts.stock_unsynced ?? 0}</dd>
        <dt>Độ trễ (7 ngày, webhook → hóa đơn đã kiểm tra)</dt>
        <dd>
          {latency && latency.samples
            ? `trung bình ${seconds(latency.avgMs)} · P95 ${seconds(latency.p95Ms)} · ≤ 60 s: ${Math.round((latency.within60s / latency.samples) * 100)}% của ${latency.samples}`
            : "chưa có dữ liệu"}
        </dd>
        <dt>Kiểm tra trùng hóa đơn (7 ngày)</dt>
        <dd>
          {lookup && lookup.samples
            ? `PostgreSQL P95 ${ms(lookup.localP95Ms)} · làm mới chỉ mục P95 ${ms(lookup.refreshP95Ms)} · tổng P50 ${ms(lookup.totalP50Ms)} · trung bình ${ms(lookup.totalAvgMs)} · P95 ${ms(lookup.totalP95Ms)} · ${lookup.apiCallsAvg ?? "—"} request KiotViet/lần · dùng chung xác nhận ${Math.round((lookup.shared / lookup.samples) * 100)}% của ${lookup.samples}`
            : "chưa có dữ liệu"}
        </dd>
      </dl>
    </section>
  );
}
