import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const migration = readFileSync(
  path.join(process.cwd(), "database/migrations/001_initial.sql"),
  "utf8",
);
const categoryMigration = readFileSync(
  path.join(process.cwd(), "database/migrations/004_category_mappings.sql"),
  "utf8",
);
describe("database safety constraints", () => {
  it("retains history and enforces one active SKU owner without deleting existing rows", () => {
    const sql = readFileSync(path.join(process.cwd(), "database/migrations/005_active_sku_ownership.sql"), "utf8");
    expect(sql).toMatch(/DROP INDEX product_mapping_unique_complete/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX product_mapping_unique_active\s+ON product_mappings\(normalized_sku\) WHERE sync_status <> 'archived'/);
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).not.toMatch(/DELETE FROM|UPDATE product_mappings|DROP TABLE/i);
  });
  it("deduplicates provider webhook IDs", () =>
    expect(migration).toMatch(/UNIQUE\(provider, webhook_id\)/));
  it("prevents duplicate Shopify orders", () =>
    expect(migration).toMatch(/shopify_order_id text NOT NULL UNIQUE/));
  it("prevents duplicate category collections", () => {
    expect(categoryMigration).toMatch(
      /kiotviet_category_id bigint NOT NULL UNIQUE/,
    );
    expect(categoryMigration).toMatch(
      /shopify_collection_id text NOT NULL UNIQUE/,
    );
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
