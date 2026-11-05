-- Additive only. Stop the worker and scheduler before applying.
-- Rollback: database/rollback/011_invoice_automation.down.sql

-- 1. New Product-Only payment policies. Never enabled by the migration: the unverified
--    prepayment policy needs an admin's explicit confirmation in Admin → Settings, and an
--    overpaid KiotViet order (prepayment > product-only invoice) stays blocked.
--    updated_at is left alone so no invoice job is re-evaluated.
UPDATE system_settings
SET value = jsonb_build_object('allowUnverifiedPrepaymentInheritance', false, 'prepaymentExceedsInvoicePolicy', 'block') || value
WHERE key = 'orders';

-- 2. Highest KiotViet invoice id known when this app claimed the order for creation (before
--    the KiotViet order existed). Every invoice of that order has a larger id, so the invoice
--    job can prove "no invoice yet" with a short newest-first scan instead of the full index.
--    NULL for existing orders and for orders linked by recovery (they use the index).
ALTER TABLE order_mappings ADD COLUMN IF NOT EXISTS invoice_id_floor bigint;

-- 3. One scheduled index run at a time across workers.
ALTER TABLE kiotviet_invoice_index_state
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;

-- 4. Latency reporting (Admin) and the stock-retry scan read recent invoices by time.
CREATE INDEX IF NOT EXISTS invoice_mappings_invoiced_at_idx ON invoice_mappings(invoiced_at) WHERE kiotviet_invoice_id IS NOT NULL;
