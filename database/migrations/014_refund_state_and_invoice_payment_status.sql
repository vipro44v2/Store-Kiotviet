-- Additive, backward compatible. Stop the worker and scheduler before applying.
-- Rollback: database/rollback/014_refund_state_and_invoice_payment_status.down.sql

-- 1. KiotViet return → Shopify financial refund: durable state machine on refund_mappings.
--    A row is claimed (pending/processing) BEFORE Shopify is called; the Shopify refund id only
--    exists afterwards, so shopify_refund_id may now be NULL (it stays UNIQUE when set).
--    status: processing (claimed, nothing sent) | sending (refundCreate sent or outcome unknown)
--            | financial_refunded | needs_review | failed (definitely not sent) | pending
--    Existing rows keep their values; they were only ever written after a successful refund.
ALTER TABLE refund_mappings ALTER COLUMN shopify_refund_id DROP NOT NULL;
ALTER TABLE refund_mappings
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS request jsonb,
  ADD COLUMN IF NOT EXISTS response jsonb,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS failure_stage text;
-- Deterministic key per KiotViet return (also sent to Shopify as the @idempotent key).
CREATE UNIQUE INDEX IF NOT EXISTS refund_mappings_idempotency_key_idx ON refund_mappings(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- New rows only (NOT VALID): historical statuses are left untouched.
DO $$ BEGIN
  ALTER TABLE refund_mappings ADD CONSTRAINT refund_mappings_status_check CHECK (status IS NULL OR status IN
    ('pending','processing','sending','financial_refunded','needs_review','failed')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS refund_mappings_open_idx ON refund_mappings(status, updated_at)
  WHERE status IN ('pending','processing','sending','failed','needs_review');

-- 2. Invoice payment verification, independent of whether the invoice exists.
--    verified | mismatch | unverified | not_applicable; NULL while no invoice exists.
ALTER TABLE invoice_mappings
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS payment_checked_at timestamptz;
DO $$ BEGIN
  ALTER TABLE invoice_mappings ADD CONSTRAINT invoice_mappings_payment_status_check CHECK (payment_status IS NULL OR payment_status IN
    ('verified','mismatch','unverified','not_applicable'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Backfill from recorded evidence only; anything without evidence becomes 'unverified'
-- (never treated as verified). updated_at is not touched.
UPDATE invoice_mappings SET payment_status = CASE
    WHEN reconciliation->'paymentVerification'->>'status' IN ('verified','mismatch') THEN reconciliation->'paymentVerification'->>'status'
    WHEN reconciliation->'checks'->>'payment' = 'true' AND COALESCE(reconciliation->'checks'->>'paymentRecords','true') = 'true' THEN 'verified'
    WHEN reconciliation->'checks' ? 'payment' THEN 'mismatch'
    ELSE 'unverified' END
WHERE kiotviet_invoice_id IS NOT NULL AND payment_status IS NULL;
CREATE INDEX IF NOT EXISTS invoice_mappings_payment_review_idx ON invoice_mappings(payment_status)
  WHERE payment_status IN ('mismatch','unverified');
