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
  const [bypassPlanBlocked, setBypassPlanBlocked] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  function reset() {
    setPreview(null);
    setPreviewToken("");
    setApproved([]);
    setConfirmed(false);
    setBypassPlanBlocked(false);
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
      const data = await call({ step: "submit", previewToken, bypassPlanBlocked, approvedWarnings: approved, confirm: true, reason });
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
  const canSubmit = Boolean(preview?.submitAllowed && previewToken && (warnings.length === 0 || bypassPlanBlocked) && allApproved && confirmed && reason.trim().length >= 10 && !loading);
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
              <tr><th colSpan={2}>Shopify (khách đã bị tính)</th></tr>
              <tr><th>Tiền hàng Shopify</th><td>{money(preview.amounts?.shopify.merchandise, currency)}</td></tr>
              <tr><th>Phí vận chuyển Shopify</th><td>{money(preview.amounts?.shopify.shipping, currency)}</td></tr>
              <tr><th>Phí xử lý thẻ đã loại trừ</th><td>{money(preview.amounts?.shopify.excludedFees, currency)}</td></tr>
              <tr><th>Khách đã trả (trừ phí xử lý thẻ)</th><td>{money(preview.amounts?.shopify.paidForGoods, currency)}</td></tr>
              <tr><th colSpan={2}>Hóa đơn KiotViet sẽ tạo (giữ nguyên dòng đơn KiotViet)</th></tr>
              <tr><th>Tiền hàng trên hóa đơn</th><td>{money(preview.amounts?.invoice.merchandise, currency)}</td></tr>
              <tr><th>Thu khác trên hóa đơn</th><td>{money(preview.amounts?.invoice.surcharges, currency)}</td></tr>
              <tr><th>Tổng hóa đơn</th><td>{money(preview.amounts?.invoice.total, currency)}</td></tr>
              <tr><th colSpan={2}>Thanh toán trên KiotViet</th></tr>
              <tr><th>Đã trả trước trên đơn KiotViet</th><td>{money(preview.amounts?.payment.existingPrepayment, currency)}</td></tr>
              <tr><th>Thanh toán ghi thêm khi tạo hóa đơn</th><td>{money(preview.amounts?.payment.additionalPayment, currency)}</td></tr>
              <tr><th>Tổng đã ghi nhận sau hóa đơn</th><td>{money(preview.amounts?.payment.totalRecorded, currency)}</td></tr>
              <tr><th>Trả thừa</th><td>{money(preview.amounts?.payment.overpayment, currency)}</td></tr>
              <tr><th>Còn nợ trên hóa đơn</th><td>{money(preview.amounts?.payment.remainingBalance, currency)}</td></tr>
            </tbody>
          </table>
          {preview.amounts && (preview.reconciled ? (
            <p><strong>Sau khi tạo hóa đơn: số liệu khớp, không còn chênh lệch.</strong></p>
          ) : (
            <div className="error-banner">
              <strong>Chênh lệch vẫn còn SAU khi tạo hóa đơn (hóa đơn sẽ được đánh dấu cần đối soát, không được coi là đã khớp):</strong>
              <ul>{preview.remainingDifferences.map((item) => <li key={item.code}>{item.code}: {item.message} ({money(item.amount, currency)})</li>)}</ul>
            </div>
          ))}
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
          {preview.planStatus === "blocked" && (
            <p><strong>PLAN: blocked</strong> — Dry Run nghiêm ngặt chặn tạo hóa đơn tự động cho đơn này.</p>
          )}
          {warnings.length > 0 && (
            <label style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={bypassPlanBlocked}
                disabled={!preview.submitAllowed}
                onChange={(event) => { setBypassPlanBlocked(event.target.checked); if (!event.target.checked) setApproved([]); }}
              />{" "}
              <strong>Bỏ qua PLAN: blocked</strong> (chỉ cho đơn Shopify {preview.shopifyOrderId}; chỉ các cảnh báo tài chính bên dưới, không bao giờ bỏ qua các điều kiện an toàn)
            </label>
          )}
          {warnings.length > 0 && (
            <fieldset disabled={!bypassPlanBlocked}>
              <legend>Cảnh báo tài chính cần phê duyệt từng mục</legend>
              {warnings.map((warning) => (
                <label key={warning.message} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={approved.includes(warning.code)}
                    disabled={!preview.submitAllowed || !bypassPlanBlocked}
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
