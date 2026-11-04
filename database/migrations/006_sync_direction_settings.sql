-- Additive only: no rows are deleted and no existing setting is overwritten.
-- Run with the transactional migration runner while the worker and scheduler are stopped.
-- Rollback: database/rollback/006_sync_direction_settings.down.sql

-- Order creation state machine (see lib/sync/order-sync.ts).
ALTER TABLE order_mappings
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS failure_stage text;
CREATE INDEX IF NOT EXISTS order_mappings_status_idx ON order_mappings(status) WHERE kiotviet_order_id IS NULL;

-- NULL = verified sync (all pre-006 rows), 'held' = write withheld by the
-- Shopify-deduction guard, 'baseline' = operator accepted the Shopify quantity.
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS status text;
CREATE INDEX IF NOT EXISTS inventory_snapshots_baseline_idx
  ON inventory_snapshots(sku, shopify_location_id, created_at DESC);

-- Sync direction settings.
-- New installation (no data yet): KiotViet → Shopify order status is disabled.
-- Existing installation: every direction that was active before stays enabled,
-- including KiotViet → Shopify order status; an admin can disable it explicitly.
-- Keys already stored under 'synchronization' always win over these defaults.
DO $$
DECLARE
  existing_installation boolean;
  defaults jsonb;
BEGIN
  existing_installation :=
    EXISTS (SELECT 1 FROM order_mappings) OR
    EXISTS (SELECT 1 FROM product_mappings) OR
    EXISTS (SELECT 1 FROM webhook_events) OR
    EXISTS (SELECT 1 FROM sync_jobs) OR
    EXISTS (SELECT 1 FROM integrations WHERE status <> 'disconnected');
  defaults := jsonb_build_object(
    'shopifyOrdersToKiotViet', true,
    'kiotVietOrderStatusToShopify', existing_installation,
    'kiotVietInventoryToShopify', true,
    'shopifyOrderCancellationsToKiotViet', true,
    'inventoryConflictStrategy', 'hold'
  );
  INSERT INTO system_settings(key, value) VALUES ('synchronization', defaults)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value || system_settings.value, updated_at = now();
  RAISE NOTICE 'synchronization settings initialized (existing installation: %): %',
    existing_installation,
    (SELECT value FROM system_settings WHERE key = 'synchronization');
END $$;
