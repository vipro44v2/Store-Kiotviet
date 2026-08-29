ALTER TABLE refund_mappings ADD COLUMN IF NOT EXISTS financial_refund_id text;
CREATE UNIQUE INDEX IF NOT EXISTS refund_mappings_financial_refund_id_idx ON refund_mappings(financial_refund_id) WHERE financial_refund_id IS NOT NULL;
