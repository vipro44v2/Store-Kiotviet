-- Additive except for replacing one index. Stop the worker and scheduler before applying.
-- Rollback: database/rollback/009_invoice_lifecycle_and_index.down.sql

-- 1. Invoice job admission: one ACTIVE job per order (was: one job per order forever,
--    which made a partial fulfillment permanently block the later full fulfillment).
--    Terminal jobs stay as history; a new job is admitted only for a new Shopify/settings state.
DROP INDEX IF EXISTS invoice_job_order_idx;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_job_active_order_idx ON sync_jobs ((payload->>'entityId'))
  WHERE type='shopify_invoice_create' AND status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS invoice_job_entity_idx ON sync_jobs ((payload->>'entityId'), status)
  WHERE type='shopify_invoice_create';

-- 2. Validation failures were stored as needs_review, which means "a request may have
--    been sent" and blocked every later attempt. Rows written only by validation
--    (never claimed, never sent) become 'blocked', which can be re-evaluated.
UPDATE invoice_mappings SET status='blocked', updated_at=now()
WHERE status='needs_review' AND failure_stage='automatic_validation'
  AND kiotviet_invoice_id IS NULL AND claimed_at IS NULL AND claim_token IS NULL;

-- Orders parked forever by the old partial-fulfillment path are rescanned.
UPDATE order_mappings o SET invoice_check_at=NULL
WHERE o.invoice_check_at='infinity'::timestamptz AND NOT EXISTS (
  SELECT 1 FROM invoice_mappings i WHERE i.shopify_order_id=o.shopify_order_id AND i.kiotviet_invoice_id IS NOT NULL);

-- 3. Local index of every KiotViet invoice (id ascending), proving that an order
--    has no invoice without scanning all invoices per order. Read-only copy of KiotViet data.
CREATE TABLE IF NOT EXISTS kiotviet_invoice_index (
  invoice_id bigint PRIMARY KEY,
  invoice_code text NOT NULL,
  order_code text,
  status integer,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kiotviet_invoice_index_order_code_idx ON kiotviet_invoice_index(order_code) WHERE order_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS kiotviet_invoice_index_state (
  id integer PRIMARY KEY CHECK (id = 1),
  scanned_count integer NOT NULL DEFAULT 0,
  last_invoice_id bigint,
  remote_total integer,
  current_as_of timestamptz,
  generation integer NOT NULL DEFAULT 1,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kiotviet_invoice_index_state(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
