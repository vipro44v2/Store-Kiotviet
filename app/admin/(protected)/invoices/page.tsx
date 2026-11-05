import { connection } from "next/server";
import { InvoiceOverride } from "@/components/admin/invoice-override";
import { DataTable } from "@/components/admin/data-table";
import { InvoiceAutomationStatus, type InvoiceAutomationStats } from "@/components/admin/invoice-automation-status";
import { query } from "@/lib/db/client";
import { getInvoiceIndexHealth, type InvoiceIndexHealth } from "@/lib/kiotviet/invoice-index";
import { INVOICE_DISPLAY_STATUS, invoicesRepository } from "@/repositories/invoices";

export default async function InvoicesPage() {
  await connection();
  let rows: Record<string, unknown>[] = [], stats: InvoiceAutomationStats | null = null;
  let index: InvoiceIndexHealth | null = null, orders: Record<string, unknown> | undefined, error = "";
  try {
    let settings: Array<{ value: Record<string, unknown> }>;
    [rows, stats, index, settings] = await Promise.all([
      invoicesRepository.recent(), invoicesRepository.automationStats(), getInvoiceIndexHealth(),
      query<{ value: Record<string, unknown> }>("SELECT value FROM system_settings WHERE key='orders'"),
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
      {!error && <DataTable rows={rows.map((row) => ({ ...row, status: INVOICE_DISPLAY_STATUS[String(row.status)] ?? row.status }))} />}
      <div className="settings-grid">
        <InvoiceOverride />
      </div>
    </>
  );
}
