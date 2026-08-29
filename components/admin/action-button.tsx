"use client";
import { useState } from "react";
export function ActionButton({
  action,
  label,
}: {
  action: string;
  label: string;
}) {
  const [state, setState] = useState("");
  return (
    <div className="action-wrap">
      <button
        onClick={async () => {
          setState("Queueing…");
          const response = await fetch(`/api/admin/sync/${action}`, {
            method: "POST",
          });
          setState(response.ok ? "Queued" : "Failed");
        }}
      >
        {label}
      </button>
      {state && <small>{state}</small>}
    </div>
  );
}
