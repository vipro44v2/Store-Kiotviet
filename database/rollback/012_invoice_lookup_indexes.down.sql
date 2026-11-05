-- Manual rollback for 012 (indexes only; no data changes):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/012_invoice_lookup_indexes.down.sql
DROP INDEX IF EXISTS invoice_mappings_kiotviet_order_code_idx;
DROP INDEX IF EXISTS order_mappings_kiotviet_order_code_idx;
DROP INDEX IF EXISTS invoice_mappings_updated_at_idx;
DELETE FROM schema_migrations WHERE name = '012_invoice_lookup_indexes.sql';
