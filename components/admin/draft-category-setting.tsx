"use client";

import { useEffect, useState } from "react";

export function DraftCategorySetting({ initial }: { initial: number[] }) {
  const [selected, setSelected] = useState(initial);
  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/products/categories");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load categories");
      setCategories(data.categories);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load categories");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/settings/draft_product_categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryIds: selected }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      setMessage("Saved. Rules apply on the next product sync.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally { setSaving(false); }
  }
  const choices = [...new Map(categories.map((category) => [category.id, category])).values()];
  for (const id of selected) {
    if (!choices.some((category) => category.id === id)) choices.push({ id, name: "Unavailable category (remove to save)" });
  }
  return <section className="setting-card">
    <h2>Draft product categories</h2>
    <p>Products in any selected category sync as DRAFT. A matching variant makes its whole Shopify product DRAFT. Inactive and deleted products keep their existing archive behavior.</p>
    <fieldset disabled={saving || loading}>
      <legend>KiotViet categories — select any number, or leave empty</legend>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {choices.map(({ id, name }) => <label key={id} style={{ display: "block" }}>
          <input type="checkbox" checked={selected.includes(id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...new Set([...ids, id])] : ids.filter((value) => value !== id))} />
          {name} (ID: {id})
        </label>)}
      </div>
    </fieldset>
    <div>
      <button type="button" className="button" disabled={loading || saving} onClick={() => void load()}>{loading ? "Loading…" : "Reload categories"}</button>
      <button type="button" className="button button-primary" disabled={loading || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    </div>
    <small role="status">{message}</small>
  </section>;
}
