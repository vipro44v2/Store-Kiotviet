-- Manual rollback for 007_kiotviet_invoices.sql. Not run by scripts/migrate.ts.
-- Run after redeploying the pre-007 code, with the worker and scheduler stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/007_kiotviet_invoices.down.sql
-- Invoices already created in KiotViet are NOT affected. invoice_mappings is kept
-- (pre-007 code ignores it) because it is the only local record of those invoices.

-- Stop any further automatic invoicing if the 007 code is ever started again.
UPDATE system_settings SET value = value || '{"autoInvoice": false}'::jsonb, updated_at = now()
WHERE key = 'orders';

-- Lets scripts/migrate.ts apply 007 again later (it is idempotent).
DELETE FROM schema_migrations WHERE name = '007_kiotviet_invoices.sql';

-- Optional and irreversible, only after exporting the table:
--   \copy invoice_mappings TO 'invoice_mappings-backup.csv' CSV HEADER
--   DROP TABLE invoice_mappings;
