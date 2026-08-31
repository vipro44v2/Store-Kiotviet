import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const migration = readFileSync(
  path.join(process.cwd(), "database/migrations/001_initial.sql"),
  "utf8",
);
const categoryMigration=readFileSync(path.join(process.cwd(),"database/migrations/004_category_mappings.sql"),"utf8");
describe("database safety constraints", () => {
  it("deduplicates provider webhook IDs", () =>
    expect(migration).toMatch(/UNIQUE\(provider, webhook_id\)/));
  it("prevents duplicate Shopify orders", () =>
    expect(migration).toMatch(/shopify_order_id text NOT NULL UNIQUE/));
  it("prevents duplicate category collections",()=>{
    expect(categoryMigration).toMatch(/kiotviet_category_id bigint NOT NULL UNIQUE/);
    expect(categoryMigration).toMatch(/shopify_collection_id text NOT NULL UNIQUE/);
    expect(categoryMigration).toMatch(/shopify_handle text NOT NULL UNIQUE/);
  });
  it("wraps migrations in a transaction", () => {
    const runner = readFileSync(
      path.join(process.cwd(), "scripts/migrate.ts"),
      "utf8",
    );
    expect(runner).toContain('client.query("BEGIN")');
    expect(runner).toContain('client.query("ROLLBACK")');
  });
});
