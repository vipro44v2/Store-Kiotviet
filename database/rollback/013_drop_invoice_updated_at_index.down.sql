-- Manual rollback for 013 (index only):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/013_drop_invoice_updated_at_index.down.sql
CREATE INDEX IF NOT EXISTS invoice_mappings_updated_at_idx ON invoice_mappings(updated_at);
DELETE FROM schema_migrations WHERE name = '013_drop_invoice_updated_at_index.sql';
