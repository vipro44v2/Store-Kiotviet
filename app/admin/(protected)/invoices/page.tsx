import { InvoiceOverride } from "@/components/admin/invoice-override";

export default function InvoicesPage() {
  return (
    <>
      <header className="admin-header">
        <div>
          <p className="eyebrow">KiotViet</p>
          <h1>Hóa đơn thủ công</h1>
        </div>
      </header>
      <div className="settings-grid">
        <InvoiceOverride />
      </div>
    </>
  );
}
