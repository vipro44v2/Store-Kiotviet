"use client";

import { useEffect, useState } from "react";

interface SyncResult {
  queued?: number;
  missingMappings?: number;
  skipped?: number;
  created?: number;
  existing?: number;
  missing?: number;
  duplicate?: number;
  failed?: number;
  error?: string;
}

export function ProductSyncTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [mappingMessage, setMappingMessage] = useState("");
  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);
  const [categoryId, setCategoryId] = useState("");
  const [categoryMessage, setCategoryMessage] = useState("");
  const [selectedRunning, setSelectedRunning] = useState(false);
  const [mappingRunning, setMappingRunning] = useState(false);
  const [categoryRunning, setCategoryRunning] = useState(false);
  const [allRunning, setAllRunning] = useState(false);
  const [allMessage, setAllMessage] = useState("");
  const [rowRunning, setRowRunning] = useState<Set<string>>(new Set());
  const ids = rows.map((row) => String(row.id));
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const columns = Object.keys(rows[0] ?? {}).filter((column) => column !== "id").slice(0, 8);

  useEffect(() => {
    void fetch("/api/admin/products/categories")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load categories");
        return response.json() as Promise<{
          categories: Array<{ id: number; name: string }>;
        }>;
      })
      .then((result) => setCategories(result.categories))
      .catch(() => setCategoryMessage("Could not load categories"));
  }, []);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(ids));
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function queue(mappingIds: string[], rowId?: string) {
    if (!mappingIds.length) return;
    if (rowId) {
      if (rowRunning.has(rowId)) return;
      setRowRunning((current) => new Set(current).add(rowId));
      setRowStatus((current) => ({ ...current, [rowId]: "Queueing..." }));
    } else {
      if (selectedRunning) return;
      setSelectedRunning(true);
      setMessage("Queueing selected products...");
    }
    try {
      const response = await fetch("/api/admin/products/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappingIds }),
      });
      const result = (await response.json()) as SyncResult;
      const status = response.ok
        ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? result.missingMappings ?? 0}; failed: ${result.failed ?? 0}`
        : result.error ?? "Failed";
      if (rowId) setRowStatus((current) => ({ ...current, [rowId]: status }));
      else {
        setMessage(status);
        if (response.ok) setSelected(new Set());
      }
    } catch {
      if (rowId) setRowStatus((current) => ({ ...current, [rowId]: "Failed" }));
      else setMessage("Failed");
    } finally {
      if (rowId)
        setRowRunning((current) => {
          const next = new Set(current);
          next.delete(rowId);
          return next;
        });
      else setSelectedRunning(false);
    }
  }

  async function createAllMappings() {
    if (mappingRunning) return;
    setMappingRunning(true);
    setMappingMessage("Creating mappings...");
    try {
      const response = await fetch("/api/admin/products/mappings", { method: "POST" });
      const result = (await response.json()) as SyncResult;
      setMappingMessage(
        response.ok
          ? `Created: ${result.created ?? 0}; existing: ${result.existing ?? 0}; missing: ${result.missing ?? 0}; duplicate: ${result.duplicate ?? 0}`
          : result.error ?? "Failed",
      );
    } catch {
      setMappingMessage("Failed");
    } finally {
      setMappingRunning(false);
    }
  }

  async function syncCategory() {
    const selectedCategory = Number(categoryId);
    if (categoryRunning || !Number.isSafeInteger(selectedCategory) || selectedCategory <= 0) return;
    setCategoryRunning(true);
    setCategoryMessage("Queueing category products...");
    try {
      const response = await fetch("/api/admin/products/category-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: selectedCategory }),
      });
      const result = (await response.json()) as SyncResult;
      setCategoryMessage(
        response.ok
          ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? 0}; failed: ${result.failed ?? 0}`
          : result.error ?? "Failed",
      );
    } catch {
      setCategoryMessage("Failed");
    } finally {
      setCategoryRunning(false);
    }
  }

  async function syncAll() {
    if (allRunning) return;
    setAllRunning(true);
    setAllMessage("Queueing all KiotViet products...");
    try {
      const response = await fetch("/api/admin/products/sync-all", {
        method: "POST",
      });
      const result = (await response.json()) as SyncResult;
      setAllMessage(
        response.ok
          ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? 0}; failed: ${result.failed ?? 0}`
          : result.error ?? "Failed",
      );
    } catch {
      setAllMessage("Failed");
    } finally {
      setAllRunning(false);
    }
  }

  return (
    <div className="admin-table-wrap">
      <div className="header-actions">
        <select aria-label="KiotViet category" value={categoryId} disabled={categoryRunning} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">Select KiotViet category</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <button type="button" disabled={!categoryId || categoryRunning} onClick={() => void syncCategory()}>
          {categoryRunning ? "Queueing category..." : "Sync this category"}
        </button>
        {categoryMessage && <small>{categoryMessage}</small>}
        <button type="button" disabled={allRunning} onClick={() => void syncAll()}>
          {allRunning ? "Queueing all products..." : "Sync all from KiotViet"}
        </button>
        {allMessage && <small>{allMessage}</small>}
        <button type="button" onClick={toggleAll}>Select all</button>
        <button type="button" disabled={!selected.size || selectedRunning} onClick={() => void queue([...selected])}>
          {selectedRunning ? "Queueing selected..." : "Sync selected"}
        </button>
        <button type="button" disabled={mappingRunning} onClick={() => void createAllMappings()}>
          {mappingRunning ? "Creating mappings..." : "Create all mappings"}
        </button>
        {message && <small>{message}</small>}
        {mappingMessage && <small>{mappingMessage}</small>}
      </div>
      {!rows.length ? <div className="admin-empty">No records found.</div> : <table className="admin-table">
        <thead>
          <tr>
            <th><input aria-label="Select all products" type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
            {columns.map((column) => <th key={column}>{column.replaceAll("_", " ")}</th>)}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = String(row.id);
            return (
              <tr key={id}>
                <td><input aria-label={`Select ${String(row.sku ?? id)}`} type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} /></td>
                {columns.map((column) => <td key={column}>{format(row[column])}</td>)}
                <td>
                  <button type="button" disabled={rowRunning.has(id)} onClick={() => void queue([id], id)}>
                    {rowRunning.has(id) ? "Queueing..." : "Sync now"}
                  </button>
                  {rowStatus[id] && <small>{rowStatus[id]}</small>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>}
    </div>
  );
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
