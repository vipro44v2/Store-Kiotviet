# Order and inventory synchronization

## Who owns what

| Data | Owner | Direction written by this app |
| --- | --- | --- |
| Stock on hand | **KiotViet** | KiotViet → Shopify `available` (absolute, compare-and-set) |
| Online sale deductions | **Shopify** until KiotViet reflects them | never written back to KiotViet |
| Orders | **Shopify** (online) | Shopify → KiotViet (create, update, cancel) |
| Order status / tracking | **KiotViet** | KiotViet → Shopify only when `kiotVietOrderStatusToShopify` is on |
| Existing KiotViet customers | **KiotViet** | never overwritten |

This app never changes KiotViet stock and never creates orders to reconcile stock.

Shopify `available` = KiotViet `OnHand` − branch safety stock. KiotViet `Reserved` is intentionally **not** subtracted (commit 4af0bb3, covered by tests in `tests/unit/inventory-sync.test.ts`). Consequence: orders this app creates in KiotViet use `makeInvoice: false`, so they only reserve stock. Until the order is invoiced, KiotViet `OnHand` does not include the Shopify sale. This is the main inventory feedback loop. The guard below handles it. The rule itself was left unchanged.

Shopify `inventory_levels/update` webhooks are stored but never processed, so nothing flows from Shopify inventory back to KiotViet.

## Sync direction settings

Stored in `system_settings` under the key `synchronization`. Edit them on **Admin → Settings → Chiều đồng bộ**. Saving validates every field strictly.

| Setting | New installation | Existing installation (migration 006) | Jobs gated |
| --- | --- | --- | --- |
| `shopifyOrdersToKiotViet` | `true` | `true` | `shopify_order_create`, `shopify_order_update`, `shopify_order_cancel` |
| `shopifyOrderCancellationsToKiotViet` | `true` | `true` | `shopify_order_cancel` (also needs the setting above) |
| `kiotVietOrderStatusToShopify` | **`false`** | `true` (keeps the previous behavior) | `kiotviet_order_to_shopify`, `kiotviet_invoice_to_shopify` |
| `kiotVietInventoryToShopify` | `true` | `true` | `kiotviet_inventory_to_shopify`, `inventory_reconciliation`, `full_inventory_sync` |
| `inventoryConflictStrategy` | `"hold"` | `"hold"` | see the inventory guard below |

These existing settings are unchanged: `orders.autoCreate`, `orders.paidOnly`, `orders.syncCustomers` (customer sync; the same card also has a toggle for it), and `orders.defaultBranchId`. `orders.syncCancellation` and `inventory.enabled` were never enforced. To keep behavior identical they are still not enforced; use the new settings instead.

The settings are checked in the worker each time a job runs. This covers jobs that were queued before the change, admin retries and webhook replays. A disabled direction:
- finishes the job as `sync_jobs.status = 'skipped'` (`error_code = 'SYNC_DISABLED'`, `error` = reason) with no retries;
- marks the webhook event `status = 'ignored'`;
- logs `action = 'sync_direction_disabled'` with the reason.

The worker keeps processing every other job type. Disabling order sync never stops inventory sync. Inventory reconciliation stops its page chain at the next page when inventory sync is disabled.

If the `synchronization` row does not exist (code deployed before the migration ran), every direction stays enabled with the legacy overwrite strategy, so a deploy alone never disables an active workflow.

## Shopify → KiotViet order state machine

`order_mappings.status` while an order is being created:

| Status | Meaning | Next webhook does |
| --- | --- | --- |
| `pending_create` | One job claimed the order; nothing sent to KiotViet yet | retries later; a claim older than 15 min is taken over |
| `creating` | The create request was sent or its outcome is unknown | looks up KiotViet by `(shopifyOrderId)` in the description. If found, it links the order. Within 5 min it retries. After that it goes to **manual review** and is never re-sent |
| `create_failed` | Definitely not created (failed before sending, or KiotViet answered with a 4xx) | claims again and retries |
| `created` (later `cancelled`/`completed`) | `kiotviet_order_id` is set | updates the status (and the customer if customer sync is on); never creates |

- The advisory lock is held only in a short claim transaction. No PostgreSQL transaction is open during KiotViet or Shopify HTTP calls.
- `POST /orders` is never retried inside the HTTP client. Network failures, timeouts, 5xx responses and unreadable success bodies raise `UncertainResultError`.
- Every line item is validated before the claim. A line with a `null` or empty SKU raises `MappingError` (manual review) that names the Shopify order and line item. Every SKU must map to a KiotViet product before anything is sent, so incomplete orders are never created.
- Guest checkouts (`customer: null`), customers without an ID, and disabled customer sync create the KiotViet order without a customer (KiotViet "Khách lẻ"). The KiotViet API contract used here (`customer` is optional) needed no fallback.
- Orders with `cancelled_at` set are not created in KiotViet.
- `order_mappings.last_error` / `failure_stage` record the latest failure. `sync_logs` gets `action = 'order_sync_failed'` with the Shopify order ID and name, job type, event ID, error class, stage, SKU, line item ID, mapping status and whether it is retryable. Customer email, phone and address are never logged.

## Inventory guard for Shopify sales

Before writing, the app compares three numbers:
- the last Shopify quantity it verified (`inventory_snapshots` with `status IS NULL` or `'baseline'`);
- the current Shopify `available`;
- the new KiotViet value.

If Shopify dropped since the last verified sync (a sale) **and** the KiotViet value would raise it again, KiotViet does not reflect that sale yet:

- an open `sync_conflicts` row is created, one per SKU and location: `conflict_type = 'inventory_shopify_deduction'`, `entity_key = '<SKU>@<locationGid>'`;
- `hold` (default): Shopify is left unchanged and a `status = 'held'` snapshot is recorded. Decreases are never held;
- `kiotviet_wins`: overwrites as before but still records the conflict.

The hold clears by itself when KiotViet catches up (for example, the KiotViet order is invoiced): the conflict is auto-resolved and a new baseline is recorded. An admin can also **Resolve** the conflict. That accepts the Shopify quantity seen at detection as the baseline, so the next KiotViet sync writes again. **Ignore** keeps the hold.

## Production deployment

Run on the server. Commands assume the PM2 layout in `ecosystem.config.js` and an env file containing `DATABASE_URL` (adjust `--env-file` to yours).

```bash
cd /var/www/shopify-kiotviet
set -a; . ./.env.production; set +a        # or export DATABASE_URL another way
./scripts/backup-postgres.sh               # pg_dump to /var/backups/shopify-kiotviet
git rev-parse HEAD > /tmp/kiotviet-previous-release   # for rollback
git fetch origin && git checkout <release-commit>
npm ci
npm run typecheck && npm run test && npm run build

pm2 stop shopify-kiotviet-worker shopify-kiotviet-scheduler
npx tsx --env-file=.env.production scripts/migrate.ts   # applies 006 only
psql "$DATABASE_URL" -c "SELECT value FROM system_settings WHERE key='synchronization'"
pm2 restart shopify-kiotviet-web
pm2 start shopify-kiotviet-worker shopify-kiotviet-scheduler
pm2 logs shopify-kiotviet-worker --lines 100
npm run health:check
```

Check the stored settings before restarting the worker. To turn off KiotViet → Shopify order status after the deploy, use the admin page. Do not edit SQL by hand.

Monitor after the deploy:

```sql
SELECT type,status,count(*) FROM sync_jobs WHERE created_at > now()-interval '1 hour' GROUP BY 1,2 ORDER BY 1,2;
SELECT context->>'failureStage',context->>'mappingStatus',count(*) FROM sync_logs
  WHERE action='order_sync_failed' AND created_at > now()-interval '1 day' GROUP BY 1,2;
SELECT entity_key,shopify_value,kiotviet_value,created_at FROM sync_conflicts
  WHERE conflict_type='inventory_shopify_deduction' AND resolution_status='open' ORDER BY created_at DESC;
```

## Rollback

```bash
cd /var/www/shopify-kiotviet
pm2 stop shopify-kiotviet-worker shopify-kiotviet-scheduler
# Run while the new release is still checked out (the file only exists there):
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/rollback/006_sync_direction_settings.down.sql
git checkout "$(cat /tmp/kiotviet-previous-release)"
npm ci && npm run build
pm2 restart shopify-kiotviet-web
pm2 start shopify-kiotviet-worker shopify-kiotviet-scheduler
```

The rollback deletes nothing. It converts unfinished `pending_create`/`create_failed` rows to `creating`, which the old code understands. It keeps the added columns and the `synchronization` row (both ignored by the old code), so a later redeploy keeps admin choices. The old code returns to its previous behavior, including retrying `creating` orders after the 5-minute recovery window. Restoring the backup is needed only if the database itself is damaged.

## Recovering failed `shopify_order_update` jobs

The `Cannot read properties of null (reading 'trim')` failures left those orders in `order_mappings.status = 'creating'` without a KiotViet order. After deploying the fix:

1. Find the affected orders (read-only):
   `npx tsx --env-file=.env.production scripts/recover-shopify-order-sync.ts --list`
2. For each order, run a dry run first:
   `npx tsx --env-file=.env.production scripts/recover-shopify-order-sync.ts <shopifyOrderId>`
   It prints one of these plans:
   - **KiotViet order found**: re-run with `--apply` to link it (no new order).
   - **Stored payload has a line without SKU**: Shopify keeps a line item's SKU as it was at purchase, so fixing the product afterwards does not fix the order. Create the order in KiotViet manually with the description `Shopify <#name> (<shopifyOrderId>)`, then run
     `... <shopifyOrderId> --link-kiotviet-order <kiotVietOrderId> --apply`.
   - **Payload is valid**: `--apply` confirms that no KiotViet order references the Shopify order, resets the row to `create_failed`, and enqueues **one** `shopify_order_update` job from the latest stored webhook.
3. Do not bulk-retry old failed jobs from the admin page. A retried job for a `creating` row goes to manual review (safe, but noisy). Old `sync_jobs` and webhook events are history and are not deleted.

## Known limitations

- `findKiotVietOrderByShopifyReference` uses `GET /orders?searchTerm=<id>` and matches `(<id>)` in the description. If KiotViet does not search descriptions, uncertain creates go to manual review instead of being linked automatically. This is safe, but needs the recovery script.
- Line quantities use `line_items[].quantity` as before. Items removed by an order edit before the order was first synced (`current_quantity = 0`) are still sent.
- The guard cannot tell a KiotViet catch-up from an unrelated in-store sale when both numbers happen to match. In that case it does not flag anything.
- KiotViet → Shopify status and invoice sync still hold a transaction (and their advisory lock) during the Shopify call. This is unchanged, and the direction is disabled by default on new installations.
- Creating a KiotViet customer (`POST /customers`) still uses the client's default retry.
