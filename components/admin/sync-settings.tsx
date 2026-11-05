"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  parseSyncSettings,
  SYNC_SETTINGS_KEY,
  type InventoryConflictStrategy,
  type SynchronizationSettings,
} from "@/lib/settings/sync-settings";

type Flag = Exclude<keyof SynchronizationSettings, "inventoryConflictStrategy">;

const flags: Array<{ key: Flag; label: string; description: string }> = [
  {
    key: "shopifyOrdersToKiotViet",
    label: "Đồng bộ đơn hàng Shopify → KiotViet",
    description: "Tạo và cập nhật đơn KiotViet từ đơn Shopify. Vẫn áp dụng các tùy chọn autoCreate và paidOnly trong cấu hình orders.",
  },
  {
    key: "shopifyOrderCancellationsToKiotViet",
    label: "Đồng bộ hủy đơn Shopify → KiotViet",
    description: "Hủy đơn KiotViet khi đơn Shopify bị hủy. Chỉ chạy khi đồng bộ đơn hàng Shopify → KiotViet đang bật.",
  },
  {
    key: "kiotVietOrderStatusToShopify",
    label: "Đồng bộ trạng thái đơn KiotViet → Shopify",
    description: "Hủy, hoàn tất (fulfill) đơn và cập nhật mã vận đơn trên Shopify theo sự kiện KiotViet. Khi tắt, sự kiện được ghi nhận là bỏ qua và không thử lại.",
  },
  {
    key: "kiotVietInventoryToShopify",
    label: "Đồng bộ tồn kho KiotViet → Shopify",
    description: "Cập nhật tồn kho Shopify từ webhook tồn kho KiotViet và đối soát định kỳ. Hoạt động độc lập với đồng bộ đơn hàng.",
  },
];

type ProductOnlyFlag = "ignoreFinancialMismatch" | "excludeShipping" | "excludeProcessingFees" | "excludeOtherSurcharges";

const productOnlyOptions: Array<{ key: ProductOnlyFlag; label: string }> = [
  { key: "excludeShipping", label: "Không đưa phí vận chuyển vào hóa đơn" },
  { key: "excludeProcessingFees", label: "Không đưa phí xử lý thanh toán vào hóa đơn" },
  { key: "excludeOtherSurcharges", label: "Không đưa tip và các khoản thu khác vào hóa đơn" },
  { key: "ignoreFinancialMismatch", label: "Chênh lệch tổng tiền do các khoản đã loại trừ không chặn tạo hóa đơn" },
];

const strategies: Array<{ value: InventoryConflictStrategy; label: string }> = [
  { value: "hold", label: "Giữ số lượng Shopify và tạo xung đột để đối soát (khuyến nghị)" },
  { value: "kiotviet_wins", label: "Ghi đè bằng tồn KiotViet và vẫn tạo xung đột (hành vi cũ)" },
];

export function SyncSettingsCard({
  stored,
  orders,
}: {
  stored: unknown;
  orders: Record<string, unknown> | undefined;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(() => parseSyncSettings(stored));
  const [syncCustomers, setSyncCustomers] = useState(orders?.syncCustomers !== false);
  const [invoiceCreationTrigger, setInvoiceCreationTrigger] = useState(String(orders?.invoiceCreationTrigger ?? "legacy"));
  const autoInvoice = invoiceCreationTrigger === "legacy" ? orders?.autoInvoice === true : invoiceCreationTrigger !== "disabled";
  const [kiotVietCurrency, setKiotVietCurrency] = useState(typeof orders?.kiotVietCurrency === "string" ? orders.kiotVietCurrency : "");
  const storedSurcharge = (orders?.shippingSurcharge ?? {}) as { id?: number; code?: string; invoiceInheritsFromOrder?: boolean };
  const [surchargeId, setSurchargeId] = useState(storedSurcharge.id ? String(storedSurcharge.id) : "");
  const [surchargeCode, setSurchargeCode] = useState(storedSurcharge.code ?? "");
  const [surchargeVerified, setSurchargeVerified] = useState(storedSurcharge.invoiceInheritsFromOrder === true);
  const [prepaymentVerified, setPrepaymentVerified] = useState(orders?.invoicePrepaymentVerified === true);
  const [productOnly, setProductOnly] = useState(orders?.productOnlyInvoicing === true);
  // Selecting Product-Only turns every exclusion on unless it was explicitly turned off.
  const [allowUnverified, setAllowUnverified] = useState(orders?.allowUnverifiedPrepaymentInheritance === true);
  // Already accepted settings stay accepted; a new enablement needs a fresh confirmation.
  const [riskConfirmed, setRiskConfirmed] = useState(orders?.allowUnverifiedPrepaymentInheritance === true && orders?.acknowledgeUnverifiedPrepaymentRisk === true);
  const [refundedItemsPolicy, setRefundedItemsPolicy] = useState(orders?.refundedItemsPolicy === "refund_means_not_shipped" ? "refund_means_not_shipped" : "verify_unshipped");
  const [overpaymentPolicy, setOverpaymentPolicy] = useState(orders?.prepaymentExceedsInvoicePolicy === "manual_override" ? "manual_override" : "block");
  const [productOnlyFlags, setProductOnlyFlags] = useState(() =>
    Object.fromEntries(productOnlyOptions.map((option) => [option.key, orders?.[option.key] !== false])) as Record<ProductOnlyFlag, boolean>);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function put(key: string, value: unknown) {
    const response = await fetch(`/api/admin/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Lưu thất bại");
    }
  }

  async function save() {
    setSaving(true);
    try {
      await put(SYNC_SETTINGS_KEY, settings);
      const currency = kiotVietCurrency.trim().toUpperCase();
      if (autoInvoice && !/^[A-Z]{3}$/.test(currency))
        throw new Error("Nhập mã tiền tệ 3 chữ cái (ví dụ USD hoặc VND) trước khi bật tự động tạo hóa đơn");
      const nextOrders: Record<string, unknown> = { ...(orders ?? {}), syncCustomers, autoInvoice: invoiceCreationTrigger === "legacy" && autoInvoice };
      if (invoiceCreationTrigger !== "legacy") nextOrders.invoiceCreationTrigger = invoiceCreationTrigger;
      if (currency) nextOrders.kiotVietCurrency = currency;
      else delete nextOrders.kiotVietCurrency;
      if (surchargeId.trim() || surchargeCode.trim()) {
        if (!/^\d+$/.test(surchargeId.trim()) || !surchargeCode.trim())
          throw new Error("Nhập cả ID và mã thu khác KiotViet cho phí vận chuyển, hoặc để trống cả hai");
        nextOrders.shippingSurcharge = { id: Number(surchargeId.trim()), code: surchargeCode.trim(), invoiceInheritsFromOrder: surchargeVerified };
      } else delete nextOrders.shippingSurcharge;
      nextOrders.invoicePrepaymentVerified = prepaymentVerified;
      if (productOnly && invoiceCreationTrigger === "legacy")
        throw new Error("Chọn Invoice Creation Trigger trước khi bật Product-Only Invoicing");
      // Written only when the mode is (or was) selected, so saving other settings never changes orders.
      if (productOnly || orders?.productOnlyInvoicing === true) {
        nextOrders.productOnlyInvoicing = productOnly;
        nextOrders.paymentSource = "shopify";
        for (const option of productOnlyOptions) nextOrders[option.key] = productOnlyFlags[option.key];
        const enableUnverified = productOnly && allowUnverified;
        if (enableUnverified && !riskConfirmed)
          throw new Error("Xác nhận rủi ro kế toán trước khi bật Allow Unverified Prepayment Inheritance");
        nextOrders.allowUnverifiedPrepaymentInheritance = enableUnverified;
        if (enableUnverified) nextOrders.acknowledgeUnverifiedPrepaymentRisk = true;
        else delete nextOrders.acknowledgeUnverifiedPrepaymentRisk;
        nextOrders.prepaymentExceedsInvoicePolicy = overpaymentPolicy;
        nextOrders.refundedItemsPolicy = refundedItemsPolicy;
      }
      if (JSON.stringify(nextOrders) !== JSON.stringify(orders ?? {})) await put("orders", nextOrders);
      setMessage("Đã lưu. Áp dụng cho cả các job đang chờ trong hàng đợi.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="setting-card">
      <h2>Chiều đồng bộ</h2>
      {stored === undefined && (
        <p>
          Chưa có cấu hình đã lưu (chưa chạy migration 006). Đang dùng hành vi cũ: tất cả các chiều đều bật.
        </p>
      )}
      <fieldset disabled={saving}>
        {flags.map((flag) => (
          <label key={flag.key} style={{ display: "block", marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={settings[flag.key]}
              onChange={(event) => setSettings({ ...settings, [flag.key]: event.target.checked })}
            />{" "}
            <strong>{flag.label}</strong>
            <br />
            <small>{flag.description}</small>
          </label>
        ))}
        <label style={{ display: "block", marginBottom: 12 }}>
          <input type="checkbox" checked={syncCustomers} onChange={(event) => setSyncCustomers(event.target.checked)} />{" "}
          <strong>Đồng bộ khách hàng Shopify → KiotViet</strong>
          <br />
          <small>
            Lưu tại orders.syncCustomers. Khi tắt, đơn hàng vẫn được tạo với khách lẻ; khách hàng KiotViet đã có không bao giờ bị ghi đè.
          </small>
        </label>
        <label style={{ display: "block", marginBottom: 12 }}>
          <strong>Invoice Creation Trigger</strong>{" "}
          <select value={invoiceCreationTrigger} onChange={(event) => setInvoiceCreationTrigger(event.target.value)}>
            {invoiceCreationTrigger === "legacy" && <option value="legacy">Existing behavior ({orders?.autoInvoice === true ? "Paid" : "Disabled"})</option>}
            <option value="shopify_fulfilled">Shopify Fulfilled (recommended)</option>
            <option value="shopify_paid">Shopify Paid</option>
            <option value="disabled">Disabled</option>
          </select>
          <p>Applies only to Shopify orders created after this trigger is enabled. Partial fulfillment and financial mismatches require manual review. Invoices deduct KiotViet stock.</p>
        </label>
        <fieldset style={{ marginBottom: 12 }}>
          <legend><strong>Product-Only Invoicing</strong></legend>
          <label>
            <input type="checkbox" checked={productOnly} onChange={(event) => setProductOnly(event.target.checked)} />{" "}
            Hóa đơn KiotViet chỉ gồm giá trị sản phẩm (đã trừ giảm giá)
          </label>
          <br />
          <small>
            Lưu tại orders.productOnlyInvoicing. Phí vận chuyển, phí xử lý thanh toán, tiền tip và các khoản thu khác không đưa vào đơn/hóa đơn KiotViet;
            chênh lệch so với tổng Shopify được ghi lại (không bao giờ đánh dấu là đã đối soát). Hóa đơn không bao giờ tạo thêm thanh toán;
            đơn đã trả trước chỉ được tạo hóa đơn tự động khi tiền trả trước bằng đúng giá trị hóa đơn và đã có bằng chứng KiotViet kế thừa thanh toán.
          </small>
          {productOnly && (
            <div style={{ marginTop: 8 }}>
              <label style={{ display: "block" }}>
                Nguồn xác nhận thanh toán{" "}
                <select value="shopify" disabled>
                  <option value="shopify">Shopify (paymentSource)</option>
                </select>
              </label>
              {productOnlyOptions.map((option) => (
                <label key={option.key} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={productOnlyFlags[option.key]}
                    onChange={(event) => setProductOnlyFlags({ ...productOnlyFlags, [option.key]: event.target.checked })}
                  />{" "}
                  {option.label} <small>({option.key})</small>
                </label>
              ))}
              <fieldset style={{ marginTop: 8 }}>
                <legend><strong>Allow Unverified Prepayment Inheritance</strong></legend>
                <label>
                  <input
                    type="checkbox"
                    checked={allowUnverified}
                    onChange={(event) => { setAllowUnverified(event.target.checked); if (!event.target.checked) setRiskConfirmed(false); }}
                  />{" "}
                  Allow Product-Only invoices to be created without prior proof that KiotViet transfers an existing order payment to the invoice.
                  No additional payment is submitted. Invoices with payment discrepancies are marked Needs Review.
                </label>
                {allowUnverified && (
                  <label style={{ display: "block", marginTop: 4 }}>
                    <input type="checkbox" checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)} />{" "}
                    <strong>Tôi hiểu rủi ro kế toán:</strong> hóa đơn có thể được tạo trước khi chứng minh KiotViet chuyển tiền trả trước sang hóa đơn;
                    nếu KiotViet không chuyển, hóa đơn sẽ hiển thị chưa thanh toán và được đánh dấu Needs Review để kế toán xử lý
                    (hệ thống không bao giờ tự tạo, sửa hoặc hoàn tiền thanh toán).
                  </label>
                )}
                {orders?.allowUnverifiedPrepaymentInheritance === true && (
                  <small>Đã bật bởi {String(orders.unverifiedPrepaymentAcceptedBy ?? "?")} lúc {String(orders.unverifiedPrepaymentAcceptedAt ?? "?")}.</small>
                )}
              </fieldset>
              <label style={{ display: "block", marginTop: 8 }}>
                Sản phẩm đã hoàn tiền{" "}
                <select value={refundedItemsPolicy} onChange={(event) => setRefundedItemsPolicy(event.target.value)}>
                  <option value="verify_unshipped">Chỉ loại khi Shopify chứng minh chưa giao (mặc định)</option>
                  <option value="refund_means_not_shipped">Hoàn tiền = không giao hàng: luôn loại số lượng đã hoàn (chính sách cửa hàng)</option>
                </select>
                <br />
                <small>
                  Lưu tại orders.refundedItemsPolicy. &ldquo;Hoàn tiền = không giao hàng&rdquo;: số lượng gửi KiotViet = số lượng đặt − số lượng đã hoàn tiền, kể cả khi
                  sản phẩm đã Fulfilled, không cần duyệt thủ công. Hoàn tiền chỉ bằng tiền (không có sản phẩm) không bao giờ làm giảm số lượng; dữ liệu hoàn tiền
                  không hợp lệ vẫn bị chặn. Đơn/hóa đơn KiotViet đã tạo không bao giờ bị sửa tự động.
                </small>
              </label>
              <label style={{ display: "block", marginTop: 8 }}>
                Tiền trả trước lớn hơn hóa đơn sản phẩm (đơn cũ, ví dụ #1071){" "}
                <select value={overpaymentPolicy} onChange={(event) => setOverpaymentPolicy(event.target.value)}>
                  <option value="block">Chặn (mặc định)</option>
                  <option value="manual_override">Cho phép ghi đè thủ công từng đơn (luôn Needs Review)</option>
                </select>
                <br />
                <small>Không bao giờ tự động; tiền trả trước hiện có không bị thay đổi, xóa, nhân đôi hay hoàn lại.</small>
              </label>
            </div>
          )}
        </fieldset>
        <label style={{ display: "block", marginBottom: 12 }}>
          <strong>Tiền tệ của giá trên KiotViet</strong>{" "}
          <input
            value={kiotVietCurrency}
            maxLength={3}
            placeholder="USD"
            style={{ width: 80 }}
            onChange={(event) => setKiotVietCurrency(event.target.value.toUpperCase())}
          />
          <br />
          <small>Lưu tại orders.kiotVietCurrency. Phải trùng tiền tệ của đơn Shopify; hệ thống không quy đổi tiền tệ.</small>
        </label>
        <fieldset style={{ marginBottom: 12 }}>
          <legend><strong>Phí vận chuyển Shopify → thu khác KiotViet</strong></legend>
          <label>ID thu khác <input value={surchargeId} inputMode="numeric" style={{ width: 100 }} onChange={(event) => setSurchargeId(event.target.value)} /></label>{" "}
          <label>Mã thu khác <input value={surchargeCode} style={{ width: 120 }} onChange={(event) => setSurchargeCode(event.target.value)} /></label>
          <br />
          <label>
            <input type="checkbox" checked={surchargeVerified} onChange={(event) => setSurchargeVerified(event.target.checked)} />{" "}
            Đã kiểm tra trên KiotViet: hóa đơn tạo từ đơn đặt hàng giữ nguyên khoản thu khác này
          </label>
          <br />
          <small>
            Lưu tại orders.shippingSurcharge. Phí vận chuyển khách đã trả được ghi vào đơn KiotViet dưới dạng thu khác (không cộng vào giá sản phẩm).
            Mã phải tồn tại trong KiotViet (GET /surchages). Đơn có phí vận chuyển chỉ được tạo hóa đơn sau khi đánh dấu đã kiểm tra.
          </small>
        </fieldset>
        <label style={{ display: "block", marginBottom: 12 }}>
          <input type="checkbox" checked={prepaymentVerified} onChange={(event) => setPrepaymentVerified(event.target.checked)} />{" "}
          <strong>Kế toán đã xác nhận cách KiotViet ghi nhận tiền trả trước khi tạo hóa đơn từ đơn đặt hàng</strong>
          <br />
          <small>
            Lưu tại orders.invoicePrepaymentVerified. Khi chưa xác nhận, nút &ldquo;Bỏ qua cảnh báo &amp; tạo hóa đơn&rdquo; bị khóa với đơn đã có tiền trả trước, để tránh ghi nhận thanh toán hai lần.
          </small>
        </label>
        <label style={{ display: "block" }}>
          <strong>Khi Shopify đã trừ tồn (đơn bán) nhưng KiotViet chưa phản ánh</strong>
          <br />
          <select
            value={settings.inventoryConflictStrategy}
            onChange={(event) => setSettings({ ...settings, inventoryConflictStrategy: event.target.value as InventoryConflictStrategy })}
          >
            {strategies.map((strategy) => (
              <option key={strategy.value} value={strategy.value}>{strategy.label}</option>
            ))}
          </select>
        </label>
      </fieldset>
      <div>
        <button type="button" className="button button-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Đang lưu…" : "Lưu cài đặt"}
        </button>
      </div>
      <small role="status">{message}</small>
    </section>
  );
}
