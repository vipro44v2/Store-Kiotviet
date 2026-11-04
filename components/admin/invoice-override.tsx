"use client";

import { useState } from "react";
import type { InvoiceOverridePreview } from "@/lib/recovery/invoice-override";

const money = (value: number | undefined, currency?: string | null) =>
  value === undefined ? "—" : `${value.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;

export function InvoiceOverride() {
  const [orderId, setOrderId] = useState("");
  const [preview, setPreview] = useState<InvoiceOverridePreview | null>(null);
  const [previewToken, setPreviewToken] = useState("");
  const [approved, setApproved] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  function reset() {
    setPreview(null);
    setPreviewToken("");
    setApproved([]);
    setConfirmed(false);
  }

  async function call(body: unknown) {
    const response = await fetch(`/api/admin/invoices/${encodeURIComponent(orderId.trim())}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.result) throw new Error(data.error || "Yêu cầu thất bại");
    return data;
  }

  async function runPreview() {
    setLoading(true);
    setMessage("");
    reset();
    try {
      const data = await call({ step: "preview" });
      setPreview(data.preview);
      setPreviewToken(data.previewToken);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể tạo bản xem trước");
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    setLoading(true);
    try {
      const data = await call({ step: "submit", previewToken, approvedWarnings: approved, confirm: true, reason });
      setMessage(data.result?.message ?? (data.success ? "Đã tạo hóa đơn" : "Không tạo hóa đơn"));
      // A token is single-purpose; any further action needs a fresh dry run.
      reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể tạo hóa đơn");
    } finally {
      setLoading(false);
    }
  }

  const warnings = preview?.warnings ?? [];
  const allApproved = warnings.every((warning) => approved.includes(warning.code));
  const canSubmit = Boolean(preview?.submitAllowed && previewToken && allApproved && confirmed && reason.trim().length >= 10 && !loading);
  const currency = preview?.amounts?.currency;

  return (
    <section className="setting-card">
      <h2>Tạo hóa đơn KiotViet thủ công (bỏ qua cảnh báo)</h2>
      <p>
        Chỉ dùng cho một đơn Shopify đã đồng bộ sang KiotViet. Bước 1 chạy Dry Run mới trên máy chủ; bước 2 máy chủ kiểm tra lại toàn bộ trước khi gửi.
        Các điều kiện an toàn (hóa đơn đã tồn tại, chỉ mục hóa đơn chưa đầy đủ, yêu cầu đang xử lý, đơn đã hủy, dữ liệu đơn thay đổi, sai mapping sản phẩm) không bao giờ được bỏ qua.
      </p>
      <label>
        Shopify Order ID{" "}
        <input value={orderId} inputMode="numeric" placeholder="7108106289336" onChange={(event) => { setOrderId(event.target.value); reset(); }} />
      </label>{" "}
      <button type="button" className="button" disabled={loading || !/^\d+$/.test(orderId.trim())} onClick={() => void runPreview()}>
        {loading && !preview ? "Đang kiểm tra…" : "1. Xem trước (Dry Run)"}
      </button>

      {preview && (
        <div>
          <table>
            <tbody>
              <tr><th>Shopify Order ID</th><td>{preview.shopifyOrderId}{preview.shopifyOrderName ? ` (${preview.shopifyOrderName})` : ""}</td></tr>
              <tr><th>KiotViet order</th><td>{preview.kiotVietOrder ? `${preview.kiotVietOrder.code} (ID ${preview.kiotVietOrder.id})` : "—"}</td></tr>
              <tr><th>Tiền hàng (theo dòng đơn KiotViet)</th><td>{money(preview.amounts?.merchandiseSubtotal, currency)}</td></tr>
              <tr><th>Phí vận chuyển Shopify</th><td>{money(preview.amounts?.shopifyShipping, currency)}</td></tr>
              <tr><th>Thu khác đã có trên đơn KiotViet</th><td>{money(preview.amounts?.orderSurcharges, currency)}</td></tr>
              <tr><th>Phí xử lý thẻ đã loại trừ</th><td>{money(preview.amounts?.excludedFees, currency)}</td></tr>
              <tr><th>Đã trả trước trên KiotViet</th><td>{money(preview.amounts?.prepaid, currency)}</td></tr>
              <tr><th>Tổng hóa đơn dự kiến</th><td>{money(preview.amounts?.invoiceTotal, currency)}</td></tr>
              <tr><th>Thanh toán ghi thêm khi tạo hóa đơn</th><td>{money(preview.amounts?.additionalPayment, currency)}</td></tr>
              <tr><th>Chênh lệch còn lại (+ còn nợ / − trả thừa)</th><td>{money(preview.amounts?.balanceAfterInvoice, currency)}</td></tr>
            </tbody>
          </table>
          <h3>Sản phẩm</h3>
          <ul>
            {preview.lines.map((line) => (
              <li key={line.productId}>{line.productCode} — {line.productName}: {line.quantity} × {money(line.price, currency)}</li>
            ))}
          </ul>
          {preview.blockers.length > 0 && (
            <div className="error-banner">
              <strong>Không thể tạo hóa đơn (không được phép bỏ qua):</strong>
              <ul>{preview.blockers.map((item) => <li key={item.message}>{item.message}</li>)}</ul>
            </div>
          )}
          {warnings.length > 0 && (
            <fieldset>
              <legend>Cảnh báo tài chính cần phê duyệt từng mục</legend>
              {warnings.map((warning) => (
                <label key={warning.message} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={approved.includes(warning.code)}
                    disabled={!preview.submitAllowed}
                    onChange={(event) => setApproved((codes) => event.target.checked ? [...new Set([...codes, warning.code])] : codes.filter((code) => code !== warning.code))}
                  />{" "}
                  {warning.message}
                </label>
              ))}
            </fieldset>
          )}
          <details>
            <summary>Payload POST /invoices chính xác</summary>
            <pre>{JSON.stringify(preview.payload, null, 2)}</pre>
          </details>
          <fieldset disabled={!preview.submitAllowed || loading}>
            <legend>2. Xác nhận</legend>
            <label style={{ display: "block" }}>
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{" "}
              Tôi đã kiểm tra bản xem trước và chấp nhận tạo hóa đơn này cho đúng đơn Shopify trên.
            </label>
            <label style={{ display: "block" }}>
              Lý do (bắt buộc, tối thiểu 10 ký tự)
              <textarea value={reason} rows={3} maxLength={1000} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button type="button" className="button button-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {loading ? "Đang xử lý…" : "Bỏ qua cảnh báo & tạo hóa đơn"}
            </button>
          </fieldset>
        </div>
      )}
      <small role="status">{message}</small>
    </section>
  );
}
