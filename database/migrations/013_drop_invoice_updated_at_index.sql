-- Index-only change. Rollback: database/rollback/013_drop_invoice_updated_at_index.down.sql
--
-- 012 added invoice_mappings(updated_at) for an Admin-only statistics query. updated_at
-- changes on every invoice_mappings update, so the index is rewritten on every write and
-- prevents HOT updates, for no read benefit: the statistics now filter on invoiced_at,
-- covered by invoice_mappings_invoiced_at_idx (011). Measured on PostgreSQL (PGlite,
-- 8,000 rows): updates ~7% faster, table + indexes ~8% smaller, statistics query unchanged.
DROP INDEX IF EXISTS invoice_mappings_updated_at_idx;
