-- Manual rollback for 010. Run after redeploying pre-010 code, worker and scheduler stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/010_product_only_invoicing.down.sql
-- Invoices created in Product-Only mode stay in KiotViet and in invoice_mappings
-- (reconciliation.productOnly keeps their audit); nothing is deleted here.
ALTER TABLE invoice_mappings DROP COLUMN IF EXISTS error_code;
DROP INDEX IF EXISTS invoice_mappings_stage_idx;
ALTER TABLE kiotviet_invoice_index_state
  DROP COLUMN IF EXISTS reset_count,
  DROP COLUMN IF EXISTS last_reset_at,
  DROP COLUMN IF EXISTS reposition_count,
  DROP COLUMN IF EXISTS last_reposition_at;
-- Pre-010 code ignores the Product-Only keys; turn the mode off so a later re-deploy starts strict.
UPDATE system_settings SET value = value || '{"productOnlyInvoicing": false}'::jsonb, updated_at = now() WHERE key = 'orders';
DELETE FROM schema_migrations WHERE name = '010_product_only_invoicing.sql';
