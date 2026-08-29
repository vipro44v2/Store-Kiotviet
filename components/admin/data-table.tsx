import { RowActions } from "./row-actions";
export function DataTable({
  rows,
  resource,
}: {
  rows: Record<string, unknown>[];
  resource?: string;
}) {
  if (!rows.length) return <div className="admin-empty">No records found.</div>;
  const columns = Object.keys(rows[0]).slice(0, 9),
    actionable =
      resource === "jobs" ||
      resource === "conflicts" ||
      resource === "webhooks";
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c.replaceAll("_", " ")}</th>
            ))}
            {actionable && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {columns.map((c) => (
                <td key={c}>{format(row[c])}</td>
              ))}
              {actionable && (
                <td>
                  <RowActions
                    resource={resource}
                    id={String(row.id)}
                    status={String(row.status ?? row.resolution_status ?? "")}
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
