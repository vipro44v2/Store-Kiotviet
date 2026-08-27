CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL UNIQUE CHECK (provider IN ('shopify','kiotviet')),
  name text NOT NULL, status text NOT NULL DEFAULT 'disconnected', config jsonb NOT NULL DEFAULT '{}',
  last_health_check_at timestamptz, last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text NOT NULL, normalized_sku text NOT NULL,
  shopify_product_id text, shopify_variant_id text, shopify_inventory_item_id text,
  kiotviet_product_id bigint, kiotviet_code text, barcode text,
  sync_direction text NOT NULL DEFAULT 'manual' CHECK (sync_direction IN ('kiotviet_to_shopify','shopify_to_kiotviet','manual','disabled')),
  last_source text, last_sync_hash text, last_shopify_sync_at timestamptz, last_kiotviet_sync_at timestamptz,
  sync_status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_mappings_normalized_sku_idx ON product_mappings(normalized_sku);
CREATE INDEX IF NOT EXISTS product_mappings_shopify_variant_idx ON product_mappings(shopify_variant_id);
CREATE INDEX IF NOT EXISTS product_mappings_kiotviet_product_idx ON product_mappings(kiotviet_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS product_mapping_unique_complete ON product_mappings(normalized_sku) WHERE shopify_variant_id IS NOT NULL AND kiotviet_product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS branch_location_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kiotviet_branch_id bigint NOT NULL, kiotviet_branch_name text NOT NULL,
  shopify_location_id text NOT NULL, shopify_location_name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  safety_stock numeric NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kiotviet_branch_id, shopify_location_id)
);
CREATE TABLE IF NOT EXISTS order_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shopify_order_id text NOT NULL UNIQUE, shopify_order_number text,
  kiotviet_order_id bigint UNIQUE, kiotviet_order_code text, status text, financial_status text, fulfillment_status text,
  sync_status text NOT NULL DEFAULT 'pending', last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shopify_customer_id text NOT NULL UNIQUE, kiotviet_customer_id bigint UNIQUE,
  email text, phone text, last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fulfillment_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shopify_fulfillment_id text NOT NULL UNIQUE, shopify_order_id text NOT NULL,
  kiotviet_order_id bigint, tracking_number text, status text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refund_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shopify_refund_id text NOT NULL UNIQUE, shopify_order_id text NOT NULL,
  kiotviet_order_id bigint, amount numeric, status text, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, webhook_id text NOT NULL, event_type text NOT NULL,
  external_resource_id text, payload jsonb NOT NULL, headers jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, error text, UNIQUE(provider, webhook_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events(status, received_at DESC);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), queue_job_id text UNIQUE, type text NOT NULL, priority text NOT NULL DEFAULT 'normal',
  payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5, next_retry_at timestamptz, started_at timestamptz, completed_at timestamptz,
  error_code text, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_jobs_status_idx ON sync_jobs(status, created_at DESC);
CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL, level text NOT NULL,
  provider text, entity_type text, entity_id text, action text NOT NULL, message text NOT NULL, context jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_logs_created_idx ON sync_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text NOT NULL, branch_id bigint, shopify_location_id text,
  kiotviet_quantity numeric NOT NULL, shopify_quantity numeric, expected_shopify_quantity numeric NOT NULL,
  difference numeric, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_key text NOT NULL,
  shopify_value jsonb, kiotviet_value jsonb, conflict_type text NOT NULL, resolution_status text NOT NULL DEFAULT 'open',
  resolution jsonb, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS sync_conflicts_open_idx ON sync_conflicts(resolution_status, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text NOT NULL, actor text NOT NULL, action text NOT NULL,
  entity_type text NOT NULL, entity_id text, before_data jsonb, after_data jsonb, ip_address inet, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS system_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, severity text NOT NULL, title text NOT NULL,
  message text NOT NULL, entity_type text, entity_id text, read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY, last_seen_at timestamptz NOT NULL, status text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sync_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_type text NOT NULL, cursor text, page integer NOT NULL DEFAULT 0,
  last_processed_id text, progress integer NOT NULL DEFAULT 0, total_processed integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

INSERT INTO system_settings(key,value) VALUES
('inventory', '{"enabled":true,"source":"kiotviet","preventNegative":true,"autoReconcile":false,"reconciliationMinutes":60}'),
('products', '{"direction":"manual","priceSync":false,"titleSync":false,"descriptionSync":false,"barcodeSync":false,"variantSync":false,"imageSync":false,"statusSync":false}'),
('orders', '{"autoCreate":true,"paidOnly":true,"syncCustomers":true,"syncCancellation":true,"syncRefunds":true}'),
('retention', '{"webhookDays":30,"jobDays":30,"syncLogDays":90,"auditLogDays":180}')
ON CONFLICT (key) DO NOTHING;
