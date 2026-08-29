import { query, closeDatabase } from "../lib/db/client";

async function main() {
  await query(
    "INSERT INTO integrations(provider,name,status) VALUES ('shopify','Shopify','disconnected'),('kiotviet','KiotViet','disconnected') ON CONFLICT(provider) DO NOTHING",
  );
  process.stdout.write("Seed complete\n");
}
main()
  .finally(closeDatabase)
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
