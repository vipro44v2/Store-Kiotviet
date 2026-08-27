"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useState } from "react";
import type { KiotVietProduct } from "@/lib/kiotviet/types";

const PAGE_SIZE = 20;
const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" });

interface ProductsApiResponse {
  success: boolean;
  total?: number;
  data?: KiotVietProduct[];
  error?: string;
}

function totalInventory(product: KiotVietProduct): number {
  return product.inventories?.reduce((total, inventory) => total + (inventory.onHand ?? 0), 0) ?? 0;
}

function ProductInventory({ product }: { product: KiotVietProduct }) {
  const inventories = product.inventories ?? [];
  const total = totalInventory(product);

  return (
    <div className="inventory-cell">
      <strong className={total <= 0 ? "inventory-empty" : undefined}>
        {total.toLocaleString("vi-VN")}
      </strong>
      <span className="inventory-unit">{product.unit || "sản phẩm"}</span>
      {inventories.length > 0 && (
        <details className="inventory-details">
          <summary>{inventories.length} chi nhánh</summary>
          <div className="inventory-popover">
            {inventories.map((inventory) => (
              <div className="inventory-branch" key={inventory.branchId}>
                <span>{inventory.branchName}</span>
                <strong>{inventory.onHand.toLocaleString("vi-VN")}</strong>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function getStatus(product: KiotVietProduct): { label: string; kind: string } {
  if (product.isActive === false || product.allowsSale === false) return { label: "Inactive", kind: "muted" };
  if (totalInventory(product) <= 0) return { label: "Out of stock", kind: "warning" };
  return { label: "Active", kind: "success" };
}

export function ProductTable() {
  const [products, setProducts] = useState<KiotVietProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [input, setInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadProducts = useCallback(async (signal: AbortSignal) => {
    await Promise.resolve();
    if (signal.aborted) return;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      currentItem: String((page - 1) * PAGE_SIZE),
      includeInventory: "true",
    });
    if (searchTerm) query.set("searchTerm", searchTerm);

    try {
      const response = await fetch(`/api/kiotviet/products?${query}`, { signal, cache: "no-store" });
      const payload = (await response.json()) as ProductsApiResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || "Unable to load products");
      setProducts(payload.data ?? []);
      setTotal(payload.total ?? 0);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setProducts([]);
      setTotal(0);
      setError(caught instanceof Error ? caught.message : "Unable to load products");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [page, searchTerm]);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => void loadProducts(controller.signal), 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [loadProducts, refreshKey]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearchTerm(input.trim());
  }

  const firstItem = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastItem = Math.min(page * PAGE_SIZE, total);
  const hasNextPage = page * PAGE_SIZE < total;

  return (
    <section className="catalog-card" aria-busy={loading}>
      <div className="toolbar">
        <form className="search" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="product-search">Search products</label>
          <input
            id="product-search"
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search products"
          />
          <button type="submit">Search</button>
        </form>
        <button className="refresh" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}>
          {loading ? "Loading…" : "Refresh Products"}
        </button>
      </div>

      {error && <div className="error-banner" role="alert"><strong>Could not load products.</strong><span>{error}</span></div>}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Image</th><th>Code / SKU</th><th>Product Name</th><th>Category</th><th>Price</th><th>Stock quantity</th><th>Status</th></tr></thead>
          <tbody>
            {loading && products.length === 0 ? (
              <tr><td colSpan={7}><div className="empty-state"><span className="spinner" />Loading products…</div></td></tr>
            ) : products.length === 0 ? (
              <tr><td colSpan={7}><div className="empty-state">{error ? "Check your credentials and try again." : "No products found."}</div></td></tr>
            ) : products.map((product) => {
              const status = getStatus(product);
              return (
                <tr key={product.id}>
                  <td><div className="product-image">{product.images?.[0] ? <Image src={product.images[0]} alt="" width={52} height={52} unoptimized /> : <span>—</span>}</div></td>
                  <td><span className="sku">{product.code || "—"}</span></td>
                  <td><strong>{product.fullName || product.name}</strong>{product.unit && <small>Unit: {product.unit}</small>}</td>
                  <td>{product.categoryName || "Uncategorized"}</td>
                  <td className="price">{currency.format(product.basePrice ?? 0)}</td>
                  <td><ProductInventory product={product} /></td>
                  <td><span className={`status ${status.kind}`}>{status.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="pagination">
        <span>{total > 0 ? `${firstItem}–${lastItem} of ${total.toLocaleString("vi-VN")}` : "0 products"}</span>
        <div><button type="button" onClick={() => setPage((value) => value - 1)} disabled={loading || page === 1}>Previous</button><span>Page {page}</span><button type="button" onClick={() => setPage((value) => value + 1)} disabled={loading || !hasNextPage}>Next</button></div>
      </footer>
    </section>
  );
}
