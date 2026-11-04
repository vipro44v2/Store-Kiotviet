# Order and inventory synchronization

## Who owns what

| Data | Owner | Direction written by this app |
| --- | --- | --- |
| Stock on hand | **KiotViet** | KiotViet → Shopify `available` (absolute, compare-and-set); KiotViet invoices deduct it |
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

## Processing fees

Payment-processing fee line items (for example `SVC Fee - Credit Card Processing Fee`, which has no SKU) are not KiotViet products. They are removed before SKU validation (`lib/sync/order-line-items.ts`):

- A line is a fee when its `variant_id` is in `orders.processingFeeVariantIds` or its `product_id` is in `orders.processingFeeProductIds` (preferred; set these in the `orders` setting).
- Fallback: the line has **no SKU** and its title or name **exactly** equals an entry of `orders.processingFeeTitles` (default: `["SVC Fee - Credit Card Processing Fee"]`; set `[]` to disable). Any other line without a SKU still goes to manual review.
- The fee's charged amount (price × quantity − discount allocations, + tax lines when prices exclude tax) is subtracted from Shopify `total_price` to get the KiotViet `totalPayment`. Amounts are summed in integer minor units.
- An order that contains only fees is skipped (`fee_only_order`); no empty KiotViet order is created.
- `sync_logs` action `order_fees_excluded` records the Shopify total, the excluded fee total, the adjusted KiotViet amount and the KiotViet line total. `order_amount_mismatch` (warn) is logged when the adjusted total differs from non-fee lines + shipping + tips.

The KiotViet order lines keep the existing payload (unit price, `discount: 0`, no shipping line). For orders with discounts or shipping, the KiotViet line total therefore still differs from the payment, exactly as before. The mismatch log makes these orders visible.

## Customer phone conflicts

When KiotViet rejects a new customer with HTTP 420 "phone number already exists", the app looks the phone up in KiotViet (`+84…` and `0…` are treated as the same number). It links the existing customer only when exactly one KiotViet customer has that phone **and** either both emails are present and equal, or one side has no email and the full names match (case and diacritics ignored). The KiotViet customer is never modified. Every other case (different email, different name, several matches, the KiotViet customer is already linked to another Shopify customer) is a `ConflictError` for manual review. Duplicates and merges never happen automatically.

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

## KiotViet invoices (Auto Invoice)

Settings in `orders` (Admin → Settings → "Chiều đồng bộ"):
- `autoInvoice` ("Tự động tạo hóa đơn KiotViet"), default `false`. When it is `false`, orders are created exactly as before (`makeInvoice: false`).
- `kiotVietCurrency` ("Tiền tệ của giá trên KiotViet"), required to invoice. It must equal the Shopify order `currency`. KiotViet amounts carry no currency and nothing is converted.

**New orders.** Auto Invoice is decided in the same claim transaction as order creation, so orders that already existed when the setting was enabled are never invoiced automatically. An eligible order is created with the documented `makeInvoice: true` (KiotViet creates the invoice and its receipt and deducts stock in one request). The app then finds the invoice (`GET /invoices`, matched on `orderCode`), checks its total and payment, and records stock before and after. All of this is saved in `invoice_mappings`.

An order that is not eligible is still created, without an invoice; its `invoice_mappings.status` is `blocked`, with the reasons in `last_error`. These cases block invoicing:
- the order is cancelled, or not `paid`/`partially_refunded`;
- `kiotVietCurrency` is missing or differs from the order currency;
- product-line discounts, shipping, tax added on top of prices, or tips;
- Shopify total − processing fees ≠ Σ price × quantity;
- refunds that touch products, or a refund that is not tied to the processing fee;
- the KiotViet branch has no enabled Shopify location mapping.

**State and idempotency (`invoice_mappings`).**
- Each Shopify order, KiotViet order and KiotViet invoice can appear in at most one row (`UNIQUE` constraints). Claims use the order's advisory lock in a short transaction; HTTP calls never run inside a transaction.
- Statuses: `pending` (claimed), `creating` (request sent or outcome unknown), `created` (verified), `needs_review`, `failed` (definitely not created), `blocked` (not eligible).
- Invoice requests are never resent automatically. A timeout or crash leaves `creating`. The next webhook or the recovery script looks the invoice up in KiotViet. If it is found, it is linked; if it is still missing after 5 minutes, or two invoices exist, the row becomes `needs_review`.
- Invoices created by this app do not fulfill the Shopify order through the KiotViet → Shopify status sync. That happens only when staff add a delivery tracking number.

**Inventory.** KiotViet stays the authority and Shopify `available` is set to the absolute KiotViet value. Shopify already deducted the sale, and the invoice deducts KiotViet by the same amount, so the next sync finds equal values and writes nothing. Stock webhooks re-read the current KiotViet on-hand before writing (`inventory_event_superseded` in `sync_logs`), so an event that arrives late cannot restore sold stock.

### Enabling Auto Invoice
1. Deploy and run migration 007.
2. Find out which currency KiotViet prices are recorded in. Existing synced orders contain the Shopify amounts unconverted; compare one KiotViet order with its Shopify order.
3. Admin → Settings → "Chiều đồng bộ": enter that currency, tick "Tự động tạo hóa đơn KiotViet", then click "Lưu cài đặt".
4. Watch the first orders with `SELECT shopify_order_id,status,kiotviet_invoice_code,last_error,reconciliation FROM invoice_mappings ORDER BY created_at DESC LIMIT 20;`.

### Invoicing an existing order (#1072)
```bash
npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts --list
npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts 7108106289336          # dry run, read-only
npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts 7108106289336 --apply  # only after reviewing the plan
```
The dry run only reads.
- It uses the KiotViet order ID from `order_mappings` and never creates an order.
- It compares the stored webhook with Shopify's live status, currency, refunds and total.
- It applies the fee exclusion and financial rules above.
- It checks the KiotViet order's status, branch, location mapping, products, quantities, prices and total against Shopify.
- It reads the order's prepayment, so the invoice payment = expected total − prepayment (recorded once).
- It shows current stock, and proves no invoice exists yet. An existing invoice is linked instead of creating another.

`--apply` runs a final invoice lookup and records stock before sending one `POST /invoices` with `orderId`. It then verifies the invoice and the stock movement. If the result is uncertain, nothing is resent. Run the dry run again after 5 minutes: it links the invoice, or tells you to check KiotViet and use `--reset-uncertain --apply`.

### Verifying an invoice and its stock
- KiotViet: open the order (`kiotviet_order_code`). It should be completed and linked to the invoice (`kiotviet_invoice_code`), whose total and paid amount equal `expected_total`.
- `SELECT status,kiotviet_invoice_code,expected_total,reconciliation->'checks',reconciliation->'stockBefore',reconciliation->'stockAfter',reconciliation->'stockVerified' FROM invoice_mappings WHERE shopify_order_id='7108106289336';` (`stockVerified=false` can also mean another sale happened in between; check KiotViet stock history.)
- Shopify: after the stock webhook, `SELECT * FROM inventory_snapshots WHERE sku IN ('377','711','1045','1030') ORDER BY created_at DESC LIMIT 8;` should show `shopify_quantity = expected_shopify_quantity`, with no second decrease.

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

## Recovering failed or stuck orders

`scripts/recover-shopify-order-sync.ts` (logic in `lib/recovery/shopify-order-recovery.ts`). Positional arguments are always Shopify order IDs. A KiotViet order ID is accepted only after `--link-kiotviet-order`. Without `--apply` it only runs SELECTs and KiotViet GETs.

For every order, the dry run:
1. stops if the order is already linked;
2. **looks for an existing KiotViet order first** (description containing `(<shopifyOrderId>)`). If one exists, the plan is to relink it, never to create another;
3. applies the same fee exclusion and SKU checks as the worker to the latest stored `orders/updated`/`orders/create` payload, and prints the skipped fee lines and amounts;
4. blocks when a job for the order may still run, a worker holds the claim, a create request may still be in flight (`creating` for under 5 minutes), or order sync is disabled.

`--apply` performs only the printed action, under the order's advisory lock, and only if the mapping is unchanged since the plan was made. The job ID is deterministic, so concurrent or repeated runs recover an order at most once.

`--link-kiotviet-order` links only a KiotViet order that exists and is not cancelled, whose description mentions the Shopify order ID, that is not linked to another Shopify order, and when no other KiotViet order references this Shopify order.

Shopify keeps a line item's SKU as it was at purchase. If a real product line has no SKU, create the order in KiotViet by hand with the description `Shopify <#name> (<shopifyOrderId>)` and link it.

Old failed `sync_jobs` and webhook events stay as history. Do not bulk-retry them from the admin page.

## Known limitations

- `findKiotVietOrderByShopifyReference` uses `GET /orders?searchTerm=<id>` and matches `(<id>)` in the description. If KiotViet does not search descriptions, uncertain creates go to manual review instead of being linked automatically. This is safe, but needs the recovery script.
- Line quantities use `line_items[].quantity` as before. Items removed by an order edit before the order was first synced (`current_quantity = 0`) are still sent.
- The guard cannot tell a KiotViet catch-up from an unrelated in-store sale when both numbers happen to match. In that case it does not flag anything.
- KiotViet → Shopify status and invoice sync still hold a transaction (and their advisory lock) during the Shopify call. This is unchanged, and the direction is disabled by default on new installations.
- Creating a KiotViet customer (`POST /customers`) still uses the client's default retry.
