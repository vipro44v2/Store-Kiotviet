-- Stop workers/scheduler before applying. All changes are additive.
ALTER TABLE order_mappings ADD COLUMN IF NOT EXISTS invoice_check_at timestamptz;
CREATE INDEX IF NOT EXISTS order_invoice_check_idx ON order_mappings
  (COALESCE(invoice_check_at, created_at), shopify_order_id) WHERE kiotviet_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_job_order_idx ON sync_jobs ((payload->>'entityId'))
  WHERE type='shopify_invoice_create';
CREATE INDEX IF NOT EXISTS invoice_job_outbox_idx ON sync_jobs(created_at)
  WHERE type='shopify_invoice_create' AND queue_job_id IS NULL AND status='pending';
CREATE INDEX IF NOT EXISTS sync_jobs_cleanup_idx ON sync_jobs(completed_at)
  WHERE status IN ('completed','skipped');
DO $$
BEGIN
  -- Missing trigger on an existing installation deliberately retains the legacy path.
  IF NOT EXISTS(SELECT 1 FROM order_mappings) AND NOT EXISTS(SELECT 1 FROM product_mappings)
     AND NOT EXISTS(SELECT 1 FROM webhook_events) AND NOT EXISTS(SELECT 1 FROM sync_jobs)
     AND NOT EXISTS(SELECT 1 FROM integrations WHERE status <> 'disconnected') THEN
    UPDATE system_settings SET value=value || jsonb_build_object(
      'invoiceCreationTrigger','shopify_fulfilled','invoiceTriggerEnabledAt',now())
    WHERE key='orders' AND NOT(value ? 'invoiceCreationTrigger');
  END IF;
END $$;
