/**
 * Measures what KiotViet's GET /invoices?orderId= really does (read-only towards
 * KiotViet: GET requests only). Samples come from the local invoice index joined
 * with order_mappings: orders with known invoices, orders without any, and a
 * nonexistent order id. See lib/kiotviet/invoice-order-filter.ts.
 *
 *   npx tsx --env-file=.env.production scripts/verify-kiotviet-invoice-order-filter.ts [--samples 5]
 *   npx tsx --env-file=.env.production scripts/verify-kiotviet-invoice-order-filter.ts --record
 *
 * --record stores the result in system_settings (kiotviet_invoice_order_filter_evidence).
 * The lookup never treats the filter as proof of absence, whatever the result.
 */
import { closeDatabase, query } from "../lib/db/client";
import { kiotVietClient } from "../lib/kiotviet/client";
import { ORDER_FILTER_EVIDENCE_KEY } from "../lib/kiotviet/invoices";
import { classifyOrderFilter, type OrderFilterSample } from "../lib/kiotviet/invoice-order-filter";
import type { KiotVietInvoicesResponse } from "../lib/kiotviet/types";

const print = (line: string) => process.stdout.write(`${line}\n`);

async function filtered(orderId: number) {
  const page = await kiotVietClient.get<KiotVietInvoicesResponse>(
    `/invoices?${new URLSearchParams({ orderId: String(orderId), pageSize: "100", currentItem: "0" })}`, { timeoutMs: 15_000, maxAttempts: 2 });
  return { total: Number(page?.total ?? 0), data: (page?.data ?? []).map((invoice) => ({ id: Number(invoice.id), orderCode: invoice.orderCode ?? null })) };
}

async function main() {
  const args = process.argv.slice(2);
  const sampleIndex = args.indexOf("--samples");
  const count = sampleIndex >= 0 ? Number(args[sampleIndex + 1]) : 5;
  if (!Number.isSafeInteger(count) || count < 3 || count > 50) throw new Error("--samples must be between 3 and 50");
  const withInvoices = await query<{ order_id: string; order_code: string; invoice_ids: string[] }>(
    `SELECT o.kiotviet_order_id::text AS order_id,o.kiotviet_order_code AS order_code,array_agg(i.invoice_id::text) AS invoice_ids
    FROM order_mappings o JOIN kiotviet_invoice_index i ON i.order_code=o.kiotviet_order_code
    WHERE o.kiotviet_order_id IS NOT NULL GROUP BY 1,2 ORDER BY max(i.invoice_id) DESC LIMIT $1`, [count]);
  const withoutInvoices = await query<{ order_id: string; order_code: string }>(
    `SELECT o.kiotviet_order_id::text AS order_id,o.kiotviet_order_code AS order_code FROM order_mappings o
    WHERE o.kiotviet_order_id IS NOT NULL AND o.kiotviet_order_code IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM kiotviet_invoice_index i WHERE i.order_code=o.kiotviet_order_code)
    ORDER BY o.created_at DESC LIMIT 2`);
  const samples: OrderFilterSample[] = [];
  const rows = [...withInvoices, ...withoutInvoices.map((row) => ({ ...row, invoice_ids: [] as string[] }))];
  for (const row of rows)
    samples.push({ orderId: Number(row.order_id), orderCode: row.order_code, knownInvoiceIds: row.invoice_ids.map(Number), response: await filtered(Number(row.order_id)) });
  const control = await filtered(2_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const verdict = classifyOrderFilter(samples, control);
  for (const sample of samples)
    print(`order ${sample.orderCode} (${sample.orderId}): known ${sample.knownInvoiceIds.length}, returned ${sample.response.data.length}/${sample.response.total}`);
  print(`control (nonexistent orderId): returned ${control.total}`);
  for (const note of verdict.notes) print(`note: ${note}`);
  print(`RESULT: ${verdict.result} (never used as proof that an order has no invoice)`);
  if (args.includes("--record")) {
    const evidence = { result: verdict.result, notes: verdict.notes, samples: samples.length, testedAt: new Date().toISOString() };
    await query(
      "INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [ORDER_FILTER_EVIDENCE_KEY, JSON.stringify(evidence)],
    );
    print(`recorded in system_settings.${ORDER_FILTER_EVIDENCE_KEY}`);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
