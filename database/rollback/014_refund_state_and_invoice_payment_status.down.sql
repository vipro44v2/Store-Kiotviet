-- Manual rollback for 014. Run after redeploying pre-014 code, worker and scheduler stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/014_refund_state_and_invoice_payment_status.down.sql
-- Rows of refund attempts that never completed (shopify_refund_id IS NULL) must be resolved
-- first: pre-014 code requires shopify_refund_id. Check:
--   SELECT kiotviet_return_id,status,last_error FROM refund_mappings WHERE shopify_refund_id IS NULL;
-- A row in 'sending' may correspond to a real Shopify refund: verify it in Shopify before deleting it.
-- This script stops (NOT NULL fails) while such rows exist; it never deletes them itself.
ALTER TABLE refund_mappings ALTER COLUMN shopify_refund_id SET NOT NULL;
ALTER TABLE refund_mappings DROP CONSTRAINT IF EXISTS refund_mappings_status_check;
DROP INDEX IF EXISTS refund_mappings_idempotency_key_idx;
DROP INDEX IF EXISTS refund_mappings_open_idx;
-- The new refund_mappings columns are kept (pre-014 code ignores them) so the audit history survives.
ALTER TABLE invoice_mappings DROP CONSTRAINT IF EXISTS invoice_mappings_payment_status_check;
DROP INDEX IF EXISTS invoice_mappings_payment_review_idx;
-- payment_status / payment_checked_at are kept (ignored by pre-014 code).
DELETE FROM schema_migrations WHERE name = '014_refund_state_and_invoice_payment_status.sql';
