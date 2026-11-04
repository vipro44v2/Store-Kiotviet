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
      if (syncCustomers !== (orders?.syncCustomers !== false))
        await put("orders", { ...(orders ?? {}), syncCustomers });
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
