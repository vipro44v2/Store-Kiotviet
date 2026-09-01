"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AdminProductDto } from "@/lib/admin/product-catalog";

interface CatalogResponse {
  products: AdminProductDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  error?: string;
}
interface SyncResult {
  queued?: number; skipped?: number; created?: number; existing?: number;
  missing?: number; duplicate?: number; failed?: number; error?: string;
}

export function compactPageWindow(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total]);
  for (let page = Math.max(2, current - 2); page <= Math.min(total - 1, current + 2); page++) pages.add(page);
  const sorted = [...pages].sort((left, right) => left - right);
  const result: Array<number | "ellipsis"> = [];
  sorted.forEach((page, index) => {
    if (index && page - sorted[index - 1] > 1) result.push("ellipsis");
    result.push(page);
  });
  return result;
}

export function ProductSyncTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const requestedPageSize = Number(searchParams.get("pageSize"));
  const pageSize = [20, 40, 80, 100].includes(requestedPageSize) ? requestedPageSize : 40;
  const search = searchParams.get("search") ?? "";
  const categoryId = searchParams.get("categoryId") ?? "";
  const [searchInput, setSearchInput] = useState(search);
  const [catalog, setCatalog] = useState<CatalogResponse>({ products: [], page, pageSize, total: 0, totalPages: 1 });
  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mappingMessage, setMappingMessage] = useState("");
  const [categoryMessage, setCategoryMessage] = useState("");
  const [allMessage, setAllMessage] = useState("");
  const [selectedRunning, setSelectedRunning] = useState(false);
  const [mappingRunning, setMappingRunning] = useState(false);
  const [categoryRunning, setCategoryRunning] = useState(false);
  const [allRunning, setAllRunning] = useState(false);
  const [rowRunning, setRowRunning] = useState<Set<number>>(new Set());
  const bulkRunning = allRunning || categoryRunning || selectedRunning || mappingRunning;

  function updateQuery(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
    setLoading(true);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  useEffect(() => setSearchInput(search), [search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch(`/api/admin/products?${queryString}`, { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as CatalogResponse;
        if (!response.ok) throw new Error(result.error ?? "Could not load products");
        setCatalog(result);
        setSelected(new Set());
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not load products");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryString]);
  useEffect(() => {
    void fetch("/api/admin/products/categories")
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ categories: Array<{ id: number; name: string }> }>;
      })
      .then((result) => setCategories(result.categories))
      .catch(() => setCategoryMessage("Could not load categories"));
  }, []);
  useEffect(() => {
    if (searchInput === search) return;
    const timeout = setTimeout(() => updateQuery({ search: searchInput, page: "1" }), 400);
    return () => clearTimeout(timeout);
  }, [searchInput, search]);

  const selectedProductIds = useMemo(() => [
    ...new Set(catalog.products.filter((product) => selected.has(product.id)).map((product) => product.id)),
  ], [catalog.products, selected]);
  const allSelected = catalog.products.length > 0 && catalog.products.every((product) => selected.has(product.id));

  async function queue(productIds: number[], rowId?: number) {
    if (!productIds.length || bulkRunning || (rowId ? rowRunning.has(rowId) : selectedRunning)) return;
    if (rowId) setRowRunning((current) => new Set(current).add(rowId));
    else setSelectedRunning(true);
    setMessage(rowId ? "Queueing product..." : "Queueing selected products...");
    try {
      const response = await fetch("/api/admin/products/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: [...new Set(productIds)] }),
      });
      const result = (await response.json()) as SyncResult;
      setMessage(response.ok ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? 0}; failed: ${result.failed ?? 0}` : result.error ?? "Sync failed");
      if (response.ok && !rowId) setSelected(new Set());
    } catch { setMessage("Sync failed"); }
    finally {
      if (rowId) setRowRunning((current) => { const next = new Set(current); next.delete(rowId); return next; });
      else setSelectedRunning(false);
    }
  }

  async function syncCategory() {
    if (!categoryId || categoryRunning) return;
    setCategoryRunning(true); setCategoryMessage("Queueing category products...");
    try {
      const response = await fetch("/api/admin/products/category-sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: Number(categoryId) }),
      });
      const result = (await response.json()) as SyncResult;
      setCategoryMessage(response.ok ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? 0}; failed: ${result.failed ?? 0}` : result.error ?? "Category sync failed");
    } catch { setCategoryMessage("Category sync failed"); }
    finally { setCategoryRunning(false); }
  }

  async function syncAll() {
    if (allRunning) return;
    setAllRunning(true); setAllMessage("Queueing all KiotViet products...");
    try {
      const response = await fetch("/api/admin/products/sync-all", { method: "POST" });
      const result = (await response.json()) as SyncResult;
      setAllMessage(response.ok ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? 0}; failed: ${result.failed ?? 0}` : result.error ?? "Sync all failed");
    } catch { setAllMessage("Sync all failed"); }
    finally { setAllRunning(false); }
  }

  async function createAllMappings() {
    if (mappingRunning) return;
    setMappingRunning(true); setMappingMessage("Creating mappings...");
    try {
      const response = await fetch("/api/admin/products/mappings", { method: "POST" });
      const result = (await response.json()) as SyncResult;
      setMappingMessage(response.ok ? `Created: ${result.created ?? 0}; existing: ${result.existing ?? 0}; missing: ${result.missing ?? 0}; duplicate: ${result.duplicate ?? 0}` : result.error ?? "Mapping failed");
    } catch { setMappingMessage("Mapping failed"); }
    finally { setMappingRunning(false); }
  }

  const first = catalog.total ? (catalog.page - 1) * catalog.pageSize + 1 : 0;
  const last = Math.min(catalog.page * catalog.pageSize, catalog.total);
  const filtered = Boolean(search || categoryId);
  return (
    <div className="admin-table-wrap">
      <p className="eyebrow">Administration</p>
      <div className="product-list-heading"><h1>Products</h1><strong>{catalog.total.toLocaleString()} products</strong></div>
      <div className="header-actions">
        <input aria-label="Search products" placeholder="Search products..." value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        <select aria-label="KiotViet category" value={categoryId} onChange={(event) => updateQuery({ categoryId: event.target.value, page: "1" })}>
          <option value="">All categories</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <select aria-label="Products per page" value={pageSize} onChange={(event) => updateQuery({ pageSize: event.target.value, page: "1" })}>
          {[20, 40, 80, 100].map((size) => <option key={size} value={size}>{size} per page</option>)}
        </select>
      </div>
      <div className="header-actions">
        <button type="button" disabled={!selectedProductIds.length || bulkRunning} onClick={() => void queue(selectedProductIds)}>{selectedRunning ? "Queueing selected..." : "Sync selected"}</button>
        <button type="button" disabled={!categoryId || bulkRunning} onClick={() => void syncCategory()}>{categoryRunning ? "Queueing category..." : "Sync this category"}</button>
        <button type="button" disabled={bulkRunning} onClick={() => void syncAll()}>{allRunning ? "Queueing all products..." : "Sync all from KiotViet"}</button>
        <button type="button" disabled={bulkRunning} onClick={() => void createAllMappings()}>{mappingRunning ? "Creating mappings..." : "Create all mappings"}</button>
      </div>
      {message && <p>{message}</p>}{categoryMessage && <p>{categoryMessage}</p>}{allMessage && <p>{allMessage}</p>}{mappingMessage && <p>{mappingMessage}</p>}
      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="admin-loading">Loading products...</div>}
      {!loading && !catalog.products.length ? (
        <div className="admin-empty">{filtered ? "No products match your filters." : "No products found in this KiotViet store."}</div>
      ) : (
        <table className="admin-table" aria-busy={loading}>
          <thead><tr><th><input aria-label="Select all products" type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(catalog.products.map((product) => product.id)))} /></th><th>Image</th><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Sync status</th><th>Shopify</th><th>Action</th></tr></thead>
          <tbody>{catalog.products.map((product) => (
            <tr key={product.id}>
              <td><input aria-label={`Select ${product.sku}`} type="checkbox" checked={selected.has(product.id)} onChange={() => setSelected((current) => { const next = new Set(current); next.has(product.id) ? next.delete(product.id) : next.add(product.id); return next; })} /></td>
              <td>{product.image ? <img src={product.image} alt="" width="48" height="48" loading="lazy" /> : "—"}</td>
              <td>{product.name}{product.variant ? <small> Variant</small> : null}</td><td>{product.sku || "—"}</td><td>{product.category}</td>
              <td>{product.price.toLocaleString()}</td><td>{product.stock ?? "—"}</td><td>{product.syncStatus}</td><td>{product.shopifyMappingStatus}</td>
              <td><button type="button" disabled={bulkRunning || rowRunning.has(product.id)} onClick={() => void queue([product.id], product.id)}>{rowRunning.has(product.id) ? "Queueing..." : "Sync now"}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div className="product-pagination">
        <p>Showing {first.toLocaleString()}–{last.toLocaleString()} of {catalog.total.toLocaleString()} products</p>
        <nav aria-label="Product pagination">
          <button type="button" disabled={loading || catalog.page <= 1} onClick={() => updateQuery({ page: String(catalog.page - 1) })}>Previous</button>
          {compactPageWindow(catalog.page, catalog.totalPages).map((item, index) => item === "ellipsis" ? <span key={`ellipsis-${index}`}>…</span> : <button type="button" key={item} aria-current={item === catalog.page ? "page" : undefined} disabled={loading || item === catalog.page} onClick={() => updateQuery({ page: String(item) })}>{item}</button>)}
          <button type="button" disabled={loading || catalog.page >= catalog.totalPages || catalog.total === 0} onClick={() => updateQuery({ page: String(catalog.page + 1) })}>Next</button>
        </nav>
        <p>Page {catalog.page} of {catalog.totalPages}</p>
      </div>
    </div>
  );
}
