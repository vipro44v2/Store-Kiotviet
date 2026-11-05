import { connection } from "next/server";
import { InvoiceOverride } from "@/components/admin/invoice-override";
import { DataTable } from "@/components/admin/data-table";
import { getInvoiceIndexHealth, type InvoiceIndexHealth } from "@/lib/kiotviet/invoice-index";
import { INVOICE_DISPLAY_STATUS, invoicesRepository } from "@/repositories/invoices";

export default async function InvoicesPage() {
  await connection();
  let rows: Record<string, unknown>[] = [], counts: Array<{ status: string; count: string }> = [];
  let index: InvoiceIndexHealth | null = null, error = "";
  try {
    [rows, counts, index] = await Promise.all([invoicesRepository.recent(), invoicesRepository.counts(), getInvoiceIndexHealth()]);
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
          <section className="setting-card">
            <h2>Trạng thái hóa đơn</h2>
            <p>
              {counts.length
                ? counts.map((row) => `${INVOICE_DISPLAY_STATUS[row.status] ?? row.status}: ${row.count}`).join(" · ")
                : "Chưa có hóa đơn nào."}
            </p>
            <small>
              blocked: chưa đủ điều kiện, không có yêu cầu nào được gửi (xem error code). processing: yêu cầu đã/có thể đã gửi, không bao giờ gửi lại tự động.
              needs_review: cần kiểm tra thủ công trên KiotViet.
            </small>
          </section>
          {index && (
            <section className="setting-card">
              <h2>Chỉ mục hóa đơn KiotViet</h2>
              <p>
                {index.scanned}/{index.total ?? "?"} hóa đơn · cập nhật lúc {index.currentAsOf ? index.currentAsOf.toISOString() : "chưa bao giờ"}
                {" · "}{index.usable ? "dùng được để chống trùng hóa đơn" : "chưa dùng được (đang xây dựng lại)"}
                {index.stale ? " · CŨ (scheduler có đang chạy?)" : ""}
              </p>
              {index.lastError && <small>Lỗi gần nhất: {index.lastError}</small>}
            </section>
          )}
        </div>
      )}
      {!error && <DataTable rows={rows.map((row) => ({ ...row, status: INVOICE_DISPLAY_STATUS[String(row.status)] ?? row.status }))} />}
      <div className="settings-grid">
        <InvoiceOverride />
      </div>
    </>
  );
}
