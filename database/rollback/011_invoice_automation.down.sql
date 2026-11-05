-- Manual rollback for 011. Run after redeploying pre-011 code, worker and scheduler stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/011_invoice_automation.down.sql
-- Invoices, their payment verification and timings stay in invoice_mappings.reconciliation.
UPDATE system_settings
SET value = (value - 'acknowledgeUnverifiedPrepaymentRisk') || '{"allowUnverifiedPrepaymentInheritance": false}'::jsonb, updated_at = now()
WHERE key = 'orders';
DROP INDEX IF EXISTS invoice_mappings_invoiced_at_idx;
ALTER TABLE kiotviet_invoice_index_state DROP COLUMN IF EXISTS lease_owner, DROP COLUMN IF EXISTS lease_until;
ALTER TABLE order_mappings DROP COLUMN IF EXISTS invoice_id_floor;
DELETE FROM schema_migrations WHERE name = '011_invoice_automation.sql';
