/**
 * Measures the duplicate-invoice lookup and invoice processing on the configured
 * database. Never writes application data.
 *
 *   npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts [--iterations 1000]
 *   npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts --remote 5
 *   npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts --write-bench
 *
 * Default: the local (PostgreSQL-only) lookup step with p50/p95/max, EXPLAIN ANALYZE,
 * and the recorded invoice processing latency (last 7 days).
 * --remote N: N full lookups for recent mapped orders (KiotViet GET requests only):
 *   index refresh, candidate re-reads, API requests and total duration.
 * --write-bench: index page write, 100 single-row UPSERTs vs one batch statement, into
 *   a session TEMP copy of kiotviet_invoice_index inside a transaction that is rolled back.
 */
import { closeDatabase, getPool, query } from "../lib/db/client";
import { getInvoiceIndexHealth, localLookupSnapshot } from "../lib/kiotviet/invoice-index";
import { findKiotVietInvoicesForOrder } from "../lib/kiotviet/invoices";

const print = (line: string) => process.stdout.write(`${line}\n`);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN;
};
const summary = (label: string, values: number[]) => values.length
  ? print(`${label.padEnd(48)} n=${values.length} p50=${percentile(values, 50).toFixed(2)}ms p95=${percentile(values, 95).toFixed(2)}ms max=${Math.max(...values).toFixed(2)}ms`)
  : print(`${label}: no samples`);

async function localBench(iterations: number) {
  const codes = (await query<{ order_code: string }>(
    "SELECT order_code FROM kiotviet_invoice_index WHERE order_code IS NOT NULL ORDER BY random() LIMIT 200")).map((row) => row.order_code);
  const hits: number[] = [], misses: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const hit = i % 2 === 0 && codes.length > 0;
    const started = performance.now();
    await localLookupSnapshot({ id: 9_000_000_000 + i, code: hit ? codes[i % codes.length] : `DH-BENCH-${i}` });
    (hit ? hits : misses).push(performance.now() - started);
  }
  summary("local step, order with invoices (1 round trip)", hits);
  summary("local step, new order / miss (1 round trip)", misses);
  summary("local step, all (target < 20 ms)", [...hits, ...misses]);
  const plan = await query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT ARRAY(SELECT kiotviet_invoice_id FROM invoice_mappings
        WHERE kiotviet_invoice_id IS NOT NULL AND (kiotviet_order_id=$1 OR kiotviet_order_code=$2)
      UNION SELECT invoice_id FROM kiotviet_invoice_index WHERE order_code=$2)`, [9_000_000_001, codes[0] ?? "DH-BENCH"]);
  for (const row of plan) print(`  ${row["QUERY PLAN"]}`);
}

async function remoteBench(count: number) {
  const orders = await query<{ id: string; code: string; floor: string | null }>(
    `SELECT kiotviet_order_id::text AS id,kiotviet_order_code AS code,invoice_id_floor::text AS floor FROM order_mappings
    WHERE kiotviet_order_id IS NOT NULL AND kiotviet_order_code IS NOT NULL ORDER BY created_at DESC LIMIT $1`, [count]);
  const metrics = [];
  for (const order of orders) {
    const result = await findKiotVietInvoicesForOrder({ id: Number(order.id), code: order.code, ...(order.floor ? { invoiceIdFloor: Number(order.floor) } : {}) });
    print(`${order.code}: complete=${result.complete} invoices=${result.invoices.length} ${JSON.stringify(result.metrics)}`);
    if (result.metrics) metrics.push(result.metrics);
  }
  summary("full lookup: local", metrics.map((item) => item.localMs));
  summary("full lookup: index refresh / floor scan", metrics.map((item) => item.refreshMs));
  summary("full lookup: KiotViet part (refresh + re-reads)", metrics.map((item) => item.remoteMs));
  summary("full lookup: total (target < 1 s when fast)", metrics.map((item) => item.totalMs));
  print(`KiotViet requests per lookup: ${metrics.map((item) => item.apiCalls).join(", ")}`);
}

async function writeBench() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE bench_index (LIKE kiotviet_invoice_index INCLUDING ALL) ON COMMIT DROP");
    let next = 1;
    const page = () => Array.from({ length: 100 }, () => { const id = next++; return { id, code: `HD${id}`, orderCode: `DH${id}`, status: 1 }; });
    const single: number[] = [], batch: number[] = [];
    for (let round = 0; round < 30; round++) {
      let rows = page(), started = performance.now();
      for (const row of rows)
        await client.query(`INSERT INTO bench_index(invoice_id,invoice_code,order_code,status) VALUES($1,$2,$3,$4)
          ON CONFLICT(invoice_id) DO UPDATE SET invoice_code=EXCLUDED.invoice_code,order_code=EXCLUDED.order_code,status=EXCLUDED.status,indexed_at=now()`,
          [row.id, row.code, row.orderCode, row.status]);
      single.push(performance.now() - started);
      rows = page();
      started = performance.now();
      await client.query(`INSERT INTO bench_index(invoice_id,invoice_code,order_code,status)
        SELECT DISTINCT ON (p.id) p.id,p.code,p.order_code,p.status FROM unnest($1::bigint[],$2::text[],$3::text[],$4::int[]) AS p(id,code,order_code,status) ORDER BY p.id
        ON CONFLICT(invoice_id) DO UPDATE SET invoice_code=EXCLUDED.invoice_code,order_code=EXCLUDED.order_code,status=EXCLUDED.status,indexed_at=now()`,
        [rows.map((row) => row.id), rows.map((row) => row.code), rows.map((row) => row.orderCode), rows.map((row) => row.status)]);
      batch.push(performance.now() - started);
    }
    summary("index page write: 100 single-row UPSERTs", single);
    summary("index page write: 1 batch UPSERT", batch);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function processingLatency() {
  const [row] = await query<Record<string, string | null>>(`SELECT count(*)::text AS n,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::text AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::text AS p95, max(ms)::text AS max,
    round(100.0*count(*) FILTER (WHERE ms<=60000)/NULLIF(count(*),0),1)::text AS within_60s
    FROM (SELECT (reconciliation->'timings'->>'invoiceLatencyMs')::float8 AS ms FROM invoice_mappings
      WHERE invoiced_at>now()-interval '7 days' AND reconciliation->'timings' ? 'invoiceLatencyMs') t`);
  print(`invoice processing (webhook → verified invoice, 7 days): n=${row?.n} p50=${row?.p50 ?? "—"}ms p95=${row?.p95 ?? "—"}ms max=${row?.max ?? "—"}ms within 60 s=${row?.within_60s ?? "—"}%`);
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
  const iterations = option("--iterations", 1000);
  const remote = option("--remote", 0);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100_000) throw new Error("--iterations must be 1..100000");
  if (!Number.isSafeInteger(remote) || remote < 0 || remote > 20) throw new Error("--remote must be 0..20");
  const health = await getInvoiceIndexHealth();
  print(`index: ${health.scanned}/${health.total ?? "?"} lag=${health.lag ?? "?"} usable=${health.usable} stale=${health.stale} currentAsOf=${health.currentAsOf?.toISOString() ?? "never"}`);
  await localBench(iterations);
  await processingLatency();
  if (remote) await remoteBench(remote);
  if (args.includes("--write-bench")) await writeBench();
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
