/**
 * Measures the duplicate-invoice lookup on the configured database. Read-only.
 *
 *   npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts [--iterations 500]
 *   npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts --remote 5
 *
 * Default: PostgreSQL only (local candidates for indexed and unknown order codes),
 * plus EXPLAIN ANALYZE of the lookup query. --remote N additionally runs N full
 * lookups (KiotViet GET requests only: freshness check and candidate re-reads)
 * for recent mapped orders and prints their metrics. Nothing is written.
 */
import { closeDatabase, query } from "../lib/db/client";
import { getInvoiceIndexHealth, localInvoiceCandidates } from "../lib/kiotviet/invoice-index";
import { findKiotVietInvoicesForOrder } from "../lib/kiotviet/invoices";

const print = (line: string) => process.stdout.write(`${line}\n`);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN;
};
const summary = (label: string, values: number[]) =>
  print(`${label}: n=${values.length} p50=${percentile(values, 50).toFixed(2)}ms p95=${percentile(values, 95).toFixed(2)}ms max=${Math.max(...values).toFixed(2)}ms`);

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
  const iterations = option("--iterations", 500);
  const remote = option("--remote", 0);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100_000) throw new Error("--iterations must be 1..100000");
  if (!Number.isSafeInteger(remote) || remote < 0 || remote > 20) throw new Error("--remote must be 0..20");

  const health = await getInvoiceIndexHealth();
  print(`index: ${health.scanned}/${health.total ?? "?"} lag=${health.lag ?? "?"} usable=${health.usable} stale=${health.stale} currentAsOf=${health.currentAsOf?.toISOString() ?? "never"}`);
  const codes = (await query<{ order_code: string }>(
    "SELECT order_code FROM kiotviet_invoice_index WHERE order_code IS NOT NULL ORDER BY random() LIMIT 200")).map((row) => row.order_code);
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    // Mix of indexed codes and codes that have no invoice (the common case for a new order).
    const code = i % 2 === 0 && codes.length ? codes[i % codes.length] : `DH-BENCH-${i}`;
    const started = performance.now();
    await localInvoiceCandidates({ id: 9_000_000_000 + i, code });
    timings.push(performance.now() - started);
  }
  summary("local lookup (PostgreSQL round trip)", timings);
  const plan = await query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT kiotviet_invoice_id::text AS invoice_id FROM invoice_mappings
      WHERE kiotviet_invoice_id IS NOT NULL AND (kiotviet_order_id=$1 OR kiotviet_order_code=$2)
    UNION SELECT invoice_id::text FROM kiotviet_invoice_index WHERE order_code=$2`, [9_000_000_001, codes[0] ?? "DH-BENCH"]);
  for (const row of plan) print(`  ${row["QUERY PLAN"]}`);

  if (remote) {
    const orders = await query<{ id: string; code: string; floor: string | null }>(
      `SELECT kiotviet_order_id::text AS id,kiotviet_order_code AS code,invoice_id_floor::text AS floor FROM order_mappings
      WHERE kiotviet_order_id IS NOT NULL AND kiotviet_order_code IS NOT NULL ORDER BY created_at DESC LIMIT $1`, [remote]);
    const totals: number[] = [];
    for (const order of orders) {
      const result = await findKiotVietInvoicesForOrder({ id: Number(order.id), code: order.code, ...(order.floor ? { invoiceIdFloor: Number(order.floor) } : {}) });
      totals.push(result.metrics?.totalMs ?? NaN);
      print(`${order.code}: complete=${result.complete} invoices=${result.invoices.length} ${JSON.stringify(result.metrics)}`);
    }
    if (totals.length) summary("full lookup (incl. KiotViet requests)", totals);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
