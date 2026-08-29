ALTER TABLE refund_mappings ADD COLUMN IF NOT EXISTS kiotviet_return_id bigint;
ALTER TABLE refund_mappings ADD COLUMN IF NOT EXISTS kiotviet_return_code text;
ALTER TABLE refund_mappings ADD COLUMN IF NOT EXISTS kiotviet_invoice_id bigint;
CREATE UNIQUE INDEX IF NOT EXISTS refund_mappings_kiotviet_return_id_idx ON refund_mappings(kiotviet_return_id) WHERE kiotviet_return_id IS NOT NULL;
