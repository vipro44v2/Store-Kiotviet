/**
 * Stores sandbox prepayment evidence (from verify-kiotviet-prepayment-inheritance.ts)
 * in the production database. Dry run unless --apply. Evidence produced on the
 * production retailer itself is refused.
 *
 *   npx tsx --env-file=.env.production scripts/record-kiotviet-prepayment-evidence.ts --file evidence.json [--apply]
 */
import { readFileSync } from "node:fs";
import { closeDatabase, query } from "../lib/db/client";
import { getEnv } from "../lib/env";
import { PREPAYMENT_EVIDENCE_KEY, prepaymentEvidenceSchema } from "../lib/kiotviet/prepayment-evidence";

const print = (line: string) => process.stdout.write(`${line}\n`);

async function main() {
  const index = process.argv.indexOf("--file");
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  if (!file) throw new Error("--file <evidence.json> is required");
  const evidence = prepaymentEvidenceSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (evidence.retailer === getEnv().KIOTVIET_RETAILER)
    throw new Error("Evidence was produced on the production retailer; only sandbox evidence is accepted");
  print(`Evidence: ${evidence.result} (sandbox ${evidence.retailer}, invoice ${evidence.invoice.code}, ${evidence.testedAt})`);
  print(`order prepaid ${evidence.order.prepaid}; invoice total ${evidence.invoice.total}, paid ${evidence.invoice.totalPayment}, payment rows ${JSON.stringify(evidence.invoice.paymentRows)}`);
  if (!process.argv.includes("--apply")) return print("DRY RUN: nothing stored. Add --apply to store it.");
  await query(
    "INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [PREPAYMENT_EVIDENCE_KEY, JSON.stringify(evidence)],
  );
  print("Stored. Prepaid orders still also need accounting sign-off (orders.invoicePrepaymentVerified).");
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
