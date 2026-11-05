-- Additive only. Stop the worker and scheduler before applying.
-- Rollback: database/rollback/010_product_only_invoicing.down.sql

-- 1. Product-Only Invoicing settings. Existing installations keep strict invoicing
--    (productOnlyInvoicing=false) until an administrator explicitly selects it.
--    Existing keys always win; invoiceCreationTrigger and invoiceTriggerEnabledAt are
--    never touched, and updated_at is left alone so no invoice job is re-evaluated.
--    The exclude*/ignoreFinancialMismatch flags are deliberately not written: once the
--    mode is selected they default to true unless explicitly set to false.
UPDATE system_settings
SET value = jsonb_build_object('productOnlyInvoicing', false, 'paymentSource', 'shopify') || value
WHERE key = 'orders';

-- 2. Stable error code next to the free-text error ("shipping_not_excluded: …" → shipping_not_excluded).
ALTER TABLE invoice_mappings ADD COLUMN IF NOT EXISTS error_code text
  GENERATED ALWAYS AS (substring(last_error from '^([a-z][a-z0-9_]*):')) STORED;
CREATE INDEX IF NOT EXISTS invoice_mappings_stage_idx ON invoice_mappings(status, failure_stage)
  WHERE kiotviet_invoice_id IS NULL;

-- 3. Invoice index maintenance counters (repositioning replaces most full rebuilds).
ALTER TABLE kiotviet_invoice_index_state
  ADD COLUMN IF NOT EXISTS reset_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reset_at timestamptz,
  ADD COLUMN IF NOT EXISTS reposition_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reposition_at timestamptz;
