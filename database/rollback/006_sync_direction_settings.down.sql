-- Manual rollback for 006_sync_direction_settings.sql. Not run by scripts/migrate.ts.
-- Run only after redeploying the pre-006 code, with the worker and scheduler stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/006_sync_direction_settings.down.sql
-- No mappings, jobs, webhook events, snapshots, conflicts or settings are deleted.

-- Pre-006 code only understands 'creating' for unfinished orders. Its recovery
-- looks the order up in KiotViet before recreating it, so this is the closest
-- equivalent for rows the new state machine left unfinished.
UPDATE order_mappings
SET status = 'creating', updated_at = now()
WHERE kiotviet_order_id IS NULL AND status IN ('pending_create', 'create_failed');

-- Pre-006 code ignores the new columns and the 'synchronization' settings row.
-- Both are kept: re-deploying 006 later then preserves admin choices, because
-- the migration never overwrites stored keys. Optional, irreversible cleanup:
--   ALTER TABLE order_mappings DROP COLUMN claim_token, DROP COLUMN claimed_at,
--     DROP COLUMN last_error, DROP COLUMN failure_stage;
--   ALTER TABLE inventory_snapshots DROP COLUMN status;
--   DROP INDEX IF EXISTS order_mappings_status_idx;
--   DROP INDEX IF EXISTS inventory_snapshots_baseline_idx;

-- Lets scripts/migrate.ts apply 006 again on a later re-deploy (it is idempotent).
DELETE FROM schema_migrations WHERE name = '006_sync_direction_settings.sql';
