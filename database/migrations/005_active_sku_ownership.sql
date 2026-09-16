-- Run with the transactional migration runner while sync workers are stopped.
-- Keep all historical rows. Existing ambiguous active rows require manual review;
-- abort rather than deleting rows or choosing an owner during migration.
LOCK TABLE product_mappings IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM product_mappings WHERE sync_status <> 'archived'
    GROUP BY normalized_sku HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple active product mappings exist for a SKU; review ownership before applying 005_active_sku_ownership.sql';
  END IF;
END $$;

DROP INDEX product_mapping_unique_complete;
CREATE UNIQUE INDEX product_mapping_unique_active
  ON product_mappings(normalized_sku) WHERE sync_status <> 'archived';
