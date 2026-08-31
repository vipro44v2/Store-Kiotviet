CREATE TABLE IF NOT EXISTS category_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kiotviet_category_id bigint NOT NULL UNIQUE,
  category_name text NOT NULL,
  shopify_collection_id text NOT NULL UNIQUE,
  shopify_handle text NOT NULL UNIQUE,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
