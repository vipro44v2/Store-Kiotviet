"use client";

import { useState } from "react";

interface SyncResult {
  queued?: number;
  missingMappings?: number;
  skipped?: number;
  created?: number;
  existing?: number;
  missing?: number;
  duplicate?: number;
  error?: string;
}

export function ProductSyncTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [mappingMessage, setMappingMessage] = useState("");
  const ids = rows.map((row) => String(row.id));
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const columns = Object.keys(rows[0] ?? {}).filter((column) => column !== "id").slice(0, 8);

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
    if (rowId) setRowStatus((current) => ({ ...current, [rowId]: "Queueing…" }));
    else setMessage("Queueing…");
    try {
      const response = await fetch("/api/admin/products/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappingIds }),
      });
      const result = (await response.json()) as SyncResult;
      const status = response.ok
        ? `Queued: ${result.queued ?? 0}; skipped: ${result.skipped ?? result.missingMappings ?? 0}`
        : result.error ?? "Failed";
      if (rowId) setRowStatus((current) => ({ ...current, [rowId]: status }));
      else {
        setMessage(status);
        if (response.ok) setSelected(new Set());
      }
    } catch {
      if (rowId) setRowStatus((current) => ({ ...current, [rowId]: "Failed" }));
      else setMessage("Failed");
    }
  }

  async function createAllMappings() {
    setMappingMessage("Creating mappings…");
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
    }
  }

  return (
    <div className="admin-table-wrap">
      <div className="header-actions">
        <button type="button" onClick={toggleAll}>Select all</button>
        <button type="button" disabled={!selected.size} onClick={() => void queue([...selected])}>
          Sync selected
        </button>
        <button type="button" onClick={() => void createAllMappings()}>Create all mappings</button>
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
                  <button type="button" onClick={() => void queue([id], id)}>Sync now</button>
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
