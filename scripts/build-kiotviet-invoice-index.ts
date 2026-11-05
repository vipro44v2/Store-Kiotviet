/**
 * Builds or updates the local KiotViet invoice index used to prove that an
 * order has no invoice yet (lib/kiotviet/invoice-index.ts). Read-only towards
 * KiotViet; writes only kiotviet_invoice_index* tables. Resumable.
 *
 *   npx tsx --env-file=.env.production scripts/build-kiotviet-invoice-index.ts --status
 *   npx tsx --env-file=.env.production scripts/build-kiotviet-invoice-index.ts [--max-pages 200]
 */
import { closeDatabase } from "../lib/db/client";
import { advanceInvoiceIndex, getInvoiceIndexHealth, getInvoiceIndexState } from "../lib/kiotviet/invoice-index";

const print = (line: string) => process.stdout.write(`${line}\n`);

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg, index) => !["--status", "--max-pages"].includes(arg) && args[index - 1] !== "--max-pages");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Use --status or --max-pages <n>.`);
  const state = await getInvoiceIndexState();
  print(`index: ${state.scanned_count}/${state.remote_total ?? "?"} invoices, current as of ${state.current_as_of ?? "never"}, generation ${state.generation}${state.last_error ? `, last error: ${state.last_error}` : ""}`);
  const health = await getInvoiceIndexHealth();
  print(`health: ${health.usable ? "usable for duplicate detection" : "NOT usable (rebuilding)"}${health.stale ? ", stale (is the scheduler running?)" : ""}`);
  if (args.includes("--status")) return;
  const limitIndex = args.indexOf("--max-pages");
  const maxPages = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 200;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) throw new Error("--max-pages must be a positive integer");
  let pages = 0;
  while (pages < maxPages) {
    const progress = await advanceInvoiceIndex({ maxPages: Math.min(20, maxPages - pages), deadlineMs: 120_000 });
    pages += progress.pages;
    print(`indexed ${progress.scanned}/${progress.total ?? "?"} (${pages} pages)${progress.error ? ` — ${progress.error}` : ""}`);
    if (progress.current) return print(`index is current as of ${progress.currentAsOf?.toISOString()}`);
    if (progress.error || progress.pages === 0) process.exitCode = 1;
    if (progress.error || progress.pages === 0) return;
  }
  print("page limit reached; run again to continue");
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
