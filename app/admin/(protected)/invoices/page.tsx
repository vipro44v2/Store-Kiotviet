import { connection } from "next/server";
import { InvoiceOverride } from "@/components/admin/invoice-override";
import { DataTable } from "@/components/admin/data-table";
import { InvoiceAutomationStatus, type InvoiceAutomationStats } from "@/components/admin/invoice-automation-status";
import { query } from "@/lib/db/client";
import { getInvoiceIndexHealth, type InvoiceIndexHealth } from "@/lib/kiotviet/invoice-index";
import { INVOICE_DISPLAY_STATUS, invoicesRepository, type InvoiceFilter } from "@/repositories/invoices";

const FILTERS: Array<{ value: InvoiceFilter | undefined; label: string }> = [
  { value: undefined, label: "Tất cả" },
  { value: "payment_review", label: "Cần kiểm tra thanh toán (lệch / chưa xác minh)" },
  { value: "needs_review", label: "Hóa đơn cần kiểm tra (needs_review)" },
];

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await connection();
  const requested = (await searchParams).filter;
  const filter = FILTERS.find((item) => item.value && item.value === requested)?.value;
  let rows: Record<string, unknown>[] = [], adjustments: Record<string, unknown>[] = [], stats: InvoiceAutomationStats | null = null;
  let index: InvoiceIndexHealth | null = null, orders: Record<string, unknown> | undefined, error = "";
  try {
    let settings: Array<{ value: Record<string, unknown> }>;
    [rows, stats, index, settings, adjustments] = await Promise.all([
      invoicesRepository.recent(100, filter), invoicesRepository.automationStats(), getInvoiceIndexHealth(),
      query<{ value: Record<string, unknown> }>("SELECT value FROM system_settings WHERE key='orders'"),
      invoicesRepository.lineAdjustments(),
    ]);
    orders = settings[0]?.value;
  } catch (e) {
    error = e instanceof Error ? e.message : "Database unavailable";
  }
  return (
    <>
      <header className="admin-header">
        <div>
          <p className="eyebrow">KiotViet</p>
          <h1>Hóa đơn</h1>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      {!error && (
        <div className="settings-grid">
          <InvoiceAutomationStatus orders={orders} index={index} stats={stats} />
          <section className="setting-card">
            <h2>Ý nghĩa trạng thái</h2>
            <small>
              blocked: chưa đủ điều kiện, không có yêu cầu nào được gửi (xem error code). processing: yêu cầu đã/có thể đã gửi, không bao giờ gửi lại tự động.
              needs_review: hóa đơn đã tạo (giữ mã) nhưng thanh toán/tồn kho chưa khớp, hoặc kết quả chưa rõ — kiểm tra thủ công trên KiotViet, không tạo lại.
            </small>
            {index?.lastError && <p><small>Lỗi chỉ mục gần nhất: {index.lastError}</small></p>}
          </section>
        </div>
      )}
      {!error && (
        <nav aria-label="Lọc hóa đơn" style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0" }}>
          {FILTERS.map((item) => (
            <a key={item.label} href={item.value ? `?filter=${item.value}` : "?"} aria-current={item.value === filter ? "page" : undefined}
              style={{ fontWeight: item.value === filter ? 700 : 400 }}>
              {item.label}
            </a>
          ))}
        </nav>
      )}
      {!error && (
        <small>
          status: hóa đơn KiotViet có tồn tại và đã được kiểm tra hay chưa. payment_status: xác minh thanh toán riêng (verified / mismatch / unverified /
          not_applicable); outstanding là số còn nợ theo KiotViet. Hệ thống không bao giờ tự tạo hóa đơn hoặc thanh toán thứ hai để sửa chênh lệch.
        </small>
      )}
      {!error && <DataTable rows={rows.map((row) => ({ ...row, status: INVOICE_DISPLAY_STATUS[String(row.status)] ?? row.status }))} />}
      {!error && adjustments.length > 0 && (
        <>
          <header className="admin-header">
            <div>
              <p className="eyebrow">Product-Only</p>
              <h2>Điều chỉnh số lượng do hoàn tiền</h2>
              <small>
                Chỉ các đơn vị được hoàn tiền và xác nhận đã hủy (chưa giao) mới bị loại khỏi đơn/hóa đơn KiotViet. requires_verification: hoàn tiền
                không chứng minh được là hàng chưa giao (trả hàng, đã giao, thiếu dữ liệu) — hóa đơn bị chặn để kiểm tra. Đơn KiotViet đã tạo không bao giờ bị sửa tự động.
              </small>
            </div>
          </header>
          <DataTable rows={adjustments.map((row) => ({ ...row, status: INVOICE_DISPLAY_STATUS[String(row.status)] ?? row.status }))} />
        </>
      )}
      <div className="settings-grid">
        <InvoiceOverride />
      </div>
    </>
  );
}
