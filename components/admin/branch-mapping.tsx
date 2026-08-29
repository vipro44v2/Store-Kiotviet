"use client";
import { FormEvent, useEffect, useState } from "react";
interface Branch {
  id: number;
  branchName: string;
}
interface Location {
  id: string;
  name: string;
}
interface Data {
  branches: Branch[];
  locations: Location[];
  mappings: Record<string, unknown>[];
  error?: string;
}
export function BranchMapping() {
  const [data, setData] = useState<Data>({
      branches: [],
      locations: [],
      mappings: [],
    }),
    [message, setMessage] = useState("");
  async function load() {
    const r = await fetch("/api/admin/branches");
    const body = (await r.json()) as Data;
    setData(body);
  }
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => clearTimeout(task);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      branch = data.branches.find((b) => b.id === Number(form.get("branch"))),
      location = data.locations.find((l) => l.id === form.get("location"));
    if (!branch || !location) return;
    const response = await fetch("/api/admin/branches", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kiotVietBranchId: branch.id,
        kiotVietBranchName: branch.branchName,
        shopifyLocationId: location.id,
        shopifyLocationName: location.name,
        safetyStock: Number(form.get("safetyStock")),
      }),
    });
    setMessage(response.ok ? "Mapping saved" : "Unable to save mapping");
    if (response.ok) await load();
  }
  return (
    <>
      <form className="mapping-form" onSubmit={submit}>
        <label>
          KiotViet branch
          <select name="branch" required>
            {data.branches.map((b) => (
              <option value={b.id} key={b.id}>
                {b.branchName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Shopify location
          <select name="location" required>
            {data.locations.map((l) => (
              <option value={l.id} key={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Safety stock
          <input name="safetyStock" type="number" min="0" defaultValue="0" />
        </label>
        <button>Save mapping</button>
        {message && <small>{message}</small>}
      </form>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>KiotViet branch</th>
              <th>Shopify location</th>
              <th>Safety stock</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {data.mappings.map((m, i) => (
              <tr key={String(m.id ?? i)}>
                <td>{String(m.kiotviet_branch_name)}</td>
                <td>{String(m.shopify_location_name)}</td>
                <td>{String(m.safety_stock)}</td>
                <td>{m.enabled ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
