import { connection } from "next/server";
import { getDashboardData } from "@/repositories/dashboard";
import { ActionButton } from "@/components/admin/action-button";
export default async function Dashboard() {
  await connection();
  let data: Awaited<ReturnType<typeof getDashboardData>> | null = null;
  try {
    data = await getDashboardData();
  } catch {}
  const counts = Object.fromEntries(
    data?.jobs.map((j) => [j.status, j.count]) ?? [],
  );
  return (
    <>
      <header className="admin-header">
        <div>
          <p className="eyebrow">Operations overview</p>
          <h1>Dashboard</h1>
        </div>
        <div className="header-actions">
          <ActionButton action="mappings" label="Initialize mappings" variant="secondary" />
          <ActionButton action="reconcile" label="Reconcile inventory" />
        </div>
      </header>
      {!data && (
        <div className="error-banner">
          PostgreSQL is not configured or migrations have not been run.
        </div>
      )}
      <section className="metric-grid">
        <Metric icon="mapped" label="Products mapped" value={data?.mappings.mapped} />
        <Metric icon="unmapped" label="Products unmapped" value={data?.mappings.unmapped} />
        <Metric icon="pending" label="Pending jobs" value={counts.pending} />
        <Metric icon="failed" label="Failed jobs" value={counts.failed} />
        <Metric icon="reviews" label="Manual reviews" value={counts.manual_review} />
        <Metric icon="conflicts" label="Open conflicts" value={data?.conflicts} />
        <Metric icon="webhooks" label="Webhooks today" value={data?.webhooksToday} />
        <Metric icon="worker" label="Worker" value="Heartbeat monitored" />
      </section>
    </>
  );
}
const metricPaths = {
  mapped: "M4 4h10v16H4z M17 8l2 2 3-4 M7 8h4 M7 12h4 M7 16h4",
  unmapped: "M4 4h10v16H4z M18 7h4 M7 8h4 M7 12h4 M7 16h4",
  pending: "M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9 M12 7v5l3 2",
  failed: "M12 3 2 21h20L12 3z M12 9v5 M12 17v1",
  reviews: "M4 4h16v16H4z M8 8h8 M8 12h5 M8 16h3",
  conflicts: "M4 5h5l6 14h5 M17 16l3 3-3 3 M4 19h5 M15 5h5 M17 2l3 3-3 3",
  webhooks: "M9 5a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M2 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M16 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M10 8l-4 7 M14 8l4 7 M8 18h8",
  worker: "M3 12h4l3-7 4 14 3-7h4",
};
function Metric({ label, value, icon }: { label: string; value?: string; icon: keyof typeof metricPaths }) {
  return (
    <article className={`metric metric-${icon}`}>
      <div className="metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={metricPaths[icon]} /></svg></div>
      <span>{label}</span>
      <strong>{value ?? "0"}</strong>
    </article>
  );
}
