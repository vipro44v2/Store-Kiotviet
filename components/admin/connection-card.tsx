"use client";
import { useState } from "react";
export function ConnectionCard({
  provider,
}: {
  provider: "shopify" | "kiotviet";
}) {
  const [state, setState] = useState("Not checked");
  return (
    <section className="connection-card">
      <h2>{provider === "shopify" ? "Shopify" : "KiotViet"}</h2>
      <p>
        Credentials are read from server environment variables and never
        returned to this page.
      </p>
      <span className={`status-badge ${state === "Connected" ? "success" : state === "Not checked" ? "neutral" : "danger"}`}><i />{state}</span>
      <button className="button button-primary" type="button"
        onClick={async () => {
          setState("Checking…");
          const response = await fetch(`/api/admin/connections/${provider}`, {
            method: "POST",
          });
          const result = (await response.json()) as { error?: string };
          setState(
            response.ok ? "Connected" : (result.error ?? "Connection failed"),
          );
        }}
      >
        Check connection
      </button>
    </section>
  );
}
