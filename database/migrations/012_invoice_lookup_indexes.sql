-- Additive only (indexes). Stop the worker and scheduler before applying.
-- Rollback: database/rollback/012_invoice_lookup_indexes.down.sql
--
-- Local (PostgreSQL-only) part of the KiotViet duplicate-invoice lookup:
--   invoice_mappings: shopify_order_id UNIQUE (007), kiotviet_order_id UNIQUE (007),
--                     kiotviet_invoice_id UNIQUE (007), kiotviet_order_code (below)
--   kiotviet_invoice_index: order_code (009)
--   order_mappings: shopify_order_id UNIQUE (001), kiotviet_order_id UNIQUE (001), kiotviet_order_code (below;
--                   also used to map KiotViet invoice webhooks to Shopify orders)
CREATE INDEX IF NOT EXISTS invoice_mappings_kiotviet_order_code_idx ON invoice_mappings(kiotviet_order_code)
  WHERE kiotviet_order_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_mappings_kiotviet_order_code_idx ON order_mappings(kiotviet_order_code)
  WHERE kiotviet_order_code IS NOT NULL;
-- Duplicate-lookup metrics (Admin, last 7 days) read recently updated invoice rows.
CREATE INDEX IF NOT EXISTS invoice_mappings_updated_at_idx ON invoice_mappings(updated_at);
