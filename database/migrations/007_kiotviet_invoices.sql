-- Additive only. Run with the worker and scheduler stopped.
-- Rollback: database/rollback/007_kiotviet_invoices.down.sql

-- One row per Shopify order whose KiotViet invoice this app requested, verified or linked.
-- Invoice state is kept apart from order_mappings.status (order creation state).
CREATE TABLE IF NOT EXISTS invoice_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL UNIQUE REFERENCES order_mappings(shopify_order_id),
  kiotviet_order_id bigint UNIQUE,
  kiotviet_order_code text,
  kiotviet_invoice_id bigint UNIQUE,
  kiotviet_invoice_code text,
  -- pending: claimed, nothing sent | creating: request sent or outcome unknown
  -- created: verified | needs_review: uncertain or mismatched, never retried automatically
  -- failed: definitely not created, may be claimed again | blocked: not eligible (see last_error)
  status text NOT NULL CHECK (status IN ('pending','creating','created','needs_review','failed','blocked')),
  -- auto: new order created with makeInvoice | recovery: invoice created for an existing order
  -- linked: an invoice that already existed in KiotViet was linked
  source text NOT NULL CHECK (source IN ('auto','recovery','linked')),
  claim_token text,
  claimed_at timestamptz,
  expected_total numeric,
  currency text,
  reconciliation jsonb NOT NULL DEFAULT '{}',
  last_error text,
  failure_stage text,
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_mappings_status_idx ON invoice_mappings(status);

-- Auto Invoice is off unless an admin enables it; existing keys always win.
UPDATE system_settings
SET value = jsonb_build_object('autoInvoice', false) || value, updated_at = now()
WHERE key = 'orders' AND NOT (value ? 'autoInvoice');
