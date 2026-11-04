/**
 * Targeted KiotViet invoicing for Shopify orders that already have a KiotViet
 * order (e.g. #1072). Never creates a KiotViet order. Dry run (read-only) by
 * default; --apply changes only the orders named on the command line.
 * See docs/order-inventory-sync.md.
 *
 *   npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts --list
 *   npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts 7108106289336
 *   npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts 7108106289336 --apply
 */
import { query, closeDatabase } from "../lib/db/client";
import { closeQueues } from "../lib/queue/queues";
import { closeRedis } from "../lib/redis/client";
import { RecoveryArgsError } from "../lib/recovery/shopify-order-recovery";
import {
  applyInvoiceRecovery,
  describeInvoiceRecoveryPlan,
  INVOICE_RECOVERY_USAGE,
  parseInvoiceRecoveryArgs,
  planInvoiceRecovery,
} from "../lib/recovery/kiotviet-invoice-recovery";

const print = (line: string) => process.stdout.write(`${line}\n`);

async function list() {
  const tracked = await query<Record<string, unknown>>(
    `SELECT shopify_order_id,kiotviet_order_code,kiotviet_invoice_code,status,source,failure_stage,left(last_error,200) AS last_error,updated_at
    FROM invoice_mappings WHERE status <> 'created' ORDER BY updated_at DESC LIMIT 200`,
  );
  print(`Invoices not completed (${tracked.length}):`);
  for (const row of tracked) print(JSON.stringify(row));
  const untracked = await query<Record<string, unknown>>(
    `SELECT m.shopify_order_id,m.shopify_order_number,m.kiotviet_order_code,m.status,m.created_at
    FROM order_mappings m LEFT JOIN invoice_mappings i ON i.shopify_order_id=m.shopify_order_id
    WHERE m.kiotviet_order_id IS NOT NULL AND i.shopify_order_id IS NULL AND m.status='created'
    ORDER BY m.created_at DESC LIMIT 100`,
  );
  print(`\nSynced orders without a tracked invoice (${untracked.length}; staff may have invoiced some in KiotViet — the dry run checks):`);
  for (const row of untracked) print(JSON.stringify(row));
}

async function main() {
  const args = parseInvoiceRecoveryArgs(process.argv.slice(2));
  if (args.mode === "list") return list();
  print(args.apply ? "APPLY mode: only the orders listed below are changed" : "DRY RUN: read-only (add --apply to make changes)");
  for (const orderId of args.shopifyOrderIds) {
    const plan = await planInvoiceRecovery(orderId, { resetUncertain: args.resetUncertain });
    for (const line of describeInvoiceRecoveryPlan(plan)) print(line);
    if (args.apply) print(`RESULT: ${(await applyInvoiceRecovery(plan)).message}`);
    print("");
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof RecoveryArgsError) process.stderr.write(`Error: ${error.message}\n\n${INVOICE_RECOVERY_USAGE}\n`);
    else process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await closeRedis();
    await closeDatabase();
  });
