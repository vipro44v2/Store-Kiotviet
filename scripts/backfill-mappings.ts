import { loadEnvConfig } from "@next/env";
import { runMappingBackfill } from "../lib/sync/mapping-backfill";
import { closeDatabase } from "../lib/db/client";
import { closeRedis } from "../lib/redis/client";

loadEnvConfig(process.cwd());

async function main() {
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const report = await runMappingBackfill({ apply: process.argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => { await closeRedis(); await closeDatabase(); });
