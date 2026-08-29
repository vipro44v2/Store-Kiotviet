import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getPool, closeDatabase } from "../lib/db/client";

async function main() {
  const directory = path.join(process.cwd(), "database", "migrations");
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const pool = getPool();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const file of files) {
    const exists = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name=$1",
      [file],
    );
    if (exists.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(path.join(directory, file), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        file,
      ]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${file}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
main()
  .finally(closeDatabase)
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
