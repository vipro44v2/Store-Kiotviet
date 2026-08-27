import { ProductTable } from "@/components/product-table";

export default function Home() {
  return (
    <main className="page-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Retail catalog</p>
          <h1>KiotViet Products</h1>
          <p className="subtitle">Browse products and inventory directly from KiotViet Retail.</p>
        </div>
      </header>
      <ProductTable />
    </main>
  );
}
