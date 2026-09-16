# Reusing archived product SKUs

Archived `product_mappings` rows are historical records. Sync, inventory,
order mapping, and backfill use non-archived rows for current ownership.
`findBySku()` deliberately returns both active and historical rows; callers
must select the appropriate set. There is no `findByKiotVietProductId()` in
this repository; deletion resolves IDs directly and filters archived history.

For a new KiotViet ID using an archived SKU, product sync searches Shopify:

- One exact normalized match: update that product with current KiotViet data,
  resolve its status normally, and save Shopify's returned variant/inventory
  identity in a new active mapping. The archived row remains unchanged.
- No match: create a product and checkpoint its new identity.
- Multiple matches: raise `MappingError` for manual review before mutation.

Variant families follow the same rules. Matches across separate Shopify
products, or reuse that would replace unrelated active family members, require
manual review. Archived hashes and checkpoints never bypass a new owner's sync.
Normal checkpoint recovery continues to use the exact active owner.

ID-bearing deletion events never fall back to SKU. Code-only deletion events
for a SKU with multiple historical owners require a product ID for manual
review; the event cannot safely identify which owner was deleted. Delayed
inventory events from the previous owner are rejected.

## Deployment

Migration `005_active_sku_ownership.sql` is required before running the updated
application. Stop mapping writers (workers, scheduler, and web/API processes),
deploy the new code, run `npm run db:migrate` with the deployment's database
environment loaded, then restart the processes. The old application must not
run against the new index because its `ON CONFLICT` predicate is incompatible.

The migration runs transactionally through `scripts/migrate.ts`, preserves all
rows, and replaces the complete-mapping index with a unique index on
`normalized_sku WHERE sync_status <> 'archived'`. Repository writes take a
transaction-scoped SKU lock and reject other active owners, including when two
writers start with no current mapping.

If the migration reports duplicate active mappings, it rolls back. Review them
before retrying; do not delete archived history or automatically choose an owner:

```sql
SELECT normalized_sku, array_agg(id) AS mapping_ids,
       array_agg(kiotviet_product_id) AS kiotviet_product_ids
FROM product_mappings
WHERE sync_status <> 'archived'
GROUP BY normalized_sku
HAVING count(*) > 1;
```

The migration is provided with this change; deploying it is a separate step.
