-- Manual rollback for 009. Run after redeploying pre-009 code, worker and scheduler stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/009_invoice_lifecycle_and_index.down.sql
-- Restoring the old one-job-per-order index fails if an order has several invoice jobs;
-- in that case keep 009's index (pre-009 code still works with it).
DROP INDEX IF EXISTS invoice_job_active_order_idx;
DROP INDEX IF EXISTS invoice_job_entity_idx;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_job_order_idx ON sync_jobs ((payload->>'entityId'))
  WHERE type='shopify_invoice_create';
-- The invoice index tables are a read-only cache of KiotViet data; keep or drop them:
--   DROP TABLE kiotviet_invoice_index; DROP TABLE kiotviet_invoice_index_state;
DELETE FROM schema_migrations WHERE name = '009_invoice_lifecycle_and_index.sql';
