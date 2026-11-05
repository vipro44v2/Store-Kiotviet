# Product-Only Invoicing

Extends the Shopify → KiotViet invoice pipeline (`docs/fulfillment-invoices.md`).
Workflow: **Shopify Paid + Fulfilled → KiotViet order → KiotViet invoice → stock deducted in KiotViet → KiotViet on-hand pushed to Shopify.**
Nothing was deployed and no production record was changed while implementing this.

## Settings (`system_settings.orders`)

| Key | Default after migration | Meaning |
| --- | --- | --- |
| `invoiceCreationTrigger` | unchanged | Keep `shopify_fulfilled`: only PAID / PARTIALLY_REFUNDED **and** fully fulfilled orders created after `invoiceTriggerEnabledAt` |
| `kiotVietCurrency` | unchanged | Keep `USD`; a different Shopify currency blocks |
| `productOnlyInvoicing` | `false` | Orders and invoices carry product merchandise only |
| `paymentSource` | `"shopify"` | Shopify's live financial status decides "customer paid" |
| `excludeShipping` / `excludeProcessingFees` / `excludeOtherSurcharges` / `ignoreFinancialMismatch` | not written (on once the mode is selected) | Excluded charges are recorded as differences instead of blocking |
| `allowUnverifiedPrepaymentInheritance` | `false` | See below. Product-Only only; needs `acknowledgeUnverifiedPrepaymentRisk` |
| `prepaymentExceedsInvoicePolicy` | `"block"` | KiotViet prepayment > product invoice (e.g. #1071): `block`, or `manual_override` (admin override per order, always `needs_review`). Never automatic |

The server records `unverifiedPrepaymentAcceptedBy/At` (the browser cannot set them) and writes an `audit_logs` row each time the unverified policy is turned on or off. Turning it off drops the acknowledgement, so turning it on again asks for confirmation again. Strict invoicing ignores both new policies.

## Invoice rules (Product-Only)

- `invoiceTotal = Σ discounted unit price × quantity` of the KiotViet order lines. New orders are created with discounted unit prices, no shipping surcharge, and `totalPayment` = merchandise paid. Historical KiotViet orders are invoiced from their own lines, unchanged.
- Shipping, processing fees, tips and other surcharges are recorded in `reconciliation.productOnly.differences` (with Shopify paid, invoice merchandise, KiotViet prepayment and payment source). They never block, and `financiallyReconciled` stays `false`.
- Still blocking: unmapped/ambiguous SKU, wrong product/quantity/price against the KiotViet order, discounts that can't be split into whole cents, invalid seller, cancelled orders, product refunds that cannot be tied to cancelled unshipped units (see below), added product tax, currency mismatch, a surcharge already on the KiotViet order, duplicate or cancelled invoices, an unknown earlier POST outcome, an inconclusive duplicate lookup.

## Refunded and cancelled items

`effectiveQuantity = originalQuantity − confirmedCancelledRefundQuantity`, per Shopify product line (`computeRefundAdjustments` in `lib/sync/product-only-invoicing.ts`). Shopify's financial status never decides physical quantities; only refund line items do.

| Refund line item | Result |
| --- | --- |
| `restock_type: cancel` (unfulfilled units removed by Shopify) | units excluded; a fully cancelled line is left out entirely |
| `no_restock`, and the successful fulfillments prove the units were not shipped (fulfilled ≤ ordered − refunded) | units excluded |
| `no_restock` without fulfillment data, or with more units fulfilled than remain | `refund_requires_verification` (blocked) |
| `return`, `legacy_restock` or no type (delivered or unknown) | `refund_requires_verification` (blocked); returns belong to the KiotViet return workflow |
| money refunded with no refund line items | no quantity change; if it exceeds the excluded charges and cancelled units → `refund_exceeds_excluded_charges` |
| `current_quantity` ≠ ordered − refunded (e.g. units removed by an order edit) | `refund_requires_verification` (blocked) |

**Merchant policy: refund means not shipped** (`orders.refundedItemsPolicy = "refund_means_not_shipped"`, Admin → Settings → Product-Only → *Sản phẩm đã hoàn tiền*).

This is a merchant-specific business rule, not Shopify semantics: this merchant never ships a refunded product. With it selected:

- **Quantity:** `effectiveQuantity = originalQuantity − refundedQuantity` for every line. Fulfilled status, restock type and tracking are ignored, and no manual approval is needed. Examples: 1 − 1 → 0 (line left out), 3 − 1 → 2, 5 − 2 → 3.
- **Deduplication:** refunds are de-duplicated by refund id, and refund line items by their id (also across refunds). The base is the original quantity, never `current_quantity`.
- **Monetary-only refunds** (no refund line items) never remove products.
- **Still blocked** (`refund_data_invalid`, `refund_exceeds_excluded_charges`, `refund_details_missing`): more units refunded than ordered, `current_quantity` inconsistent with the refunds, money refunded beyond the excluded charges and refunded units, or a partially refunded order without refund details.
- **One amount everywhere:** `merchandiseTotal = Σ effectiveQuantity × original discounted unit price` (integer cents). The same lines and amounts drive KiotViet `orderDetails`, `totalPayment`, the invoice lines and expected total, and the stock-movement check.
- **Logging:** the order-creation log lists each excluded SKU with original, excluded and remaining quantity, fulfilled quantity and the refunded amount (`lineAdjustments`).
- **Existing KiotViet orders and invoices** are never changed; a later refund is `refund_after_kiotviet_order` plus the dry-run `RECONCILE` report.

The default (`verify_unshipped`, also when the key is absent) keeps the conservative rule in the table above. Enable the policy in Admin, or, if configuration is managed in SQL:

```sql
UPDATE system_settings SET value = value || '{"refundedItemsPolicy":"refund_means_not_shipped"}'::jsonb, updated_at = now() WHERE key = 'orders';
```

- **Base quantity:** always the original `quantity`. `current_quantity` is only a cross-check, so a cancellation is never subtracted twice.
- **Repeated refunds:** de-duplicated by id, in both quantity and money.
- **Ambiguous lines:** keep their original quantity.
- **Discounts:** the discounted unit price is computed from the **original** quantity, so a cancelled unit takes its own share of the line discount. Nothing is redistributed onto the remaining units.
- **Financial records:** the cancelled value is recorded as `cancelled_items_excluded`. If Shopify's refunded subtotal for those units differs, the difference is recorded as `cancelled_refund_allocation_difference` (informational).

The same effective lines drive the KiotViet order (quantities, discounted prices, payment), invoice validation, the expected invoice payment and the stock-movement check:

- **No units left:** if every product unit was cancelled, no KiotViet order is created (`all_items_cancelled`).
- **Paid status:** in Product-Only mode a `partially_refunded` order counts as paid for order creation.
- **Existing KiotViet orders:** never changed, recreated or partly invoiced. A refund after the KiotViet order exists gives `refund_after_kiotviet_order` (blocked). Adjust the KiotViet order explicitly in KiotViet, then retry; this adjustment is deliberately not automated.

Audit: `reconciliation.productOnly.lineAdjustments` (also saved for blocked orders), the order-creation log (`lineAdjustments`) and Admin → Hóa đơn → *Điều chỉnh số lượng do hoàn tiền*. Each entry shows the original, excluded, remaining and fulfilled quantity, the reason and the detail.

The invoice snapshot reads fulfillment line items only when a refund names line items, so normal orders need no extra Shopify request.

**Fresh Shopify state before any KiotViet order.**

- **Fresh read:** before claiming an unlinked order for creation, the worker re-reads the order from Shopify (`withFreshShopifyState`). That includes the financial status, cancellation, totals, refunds with refunded quantities and restock types, current quantities, and fulfillments when refunds name line items. This happens even when the job replays a stored (possibly outdated) webhook, such as a requeue from manual recovery. Customer data still comes from the webhook.
- **Shopify unreadable:** if Shopify cannot be read, nothing is created and the job retries.
- **Ambiguous refunds:** no KiotViet order is created. The mapping is `create_failed` / `manual_review` with `failure_stage = refund_adjustments` and an actionable `last_error`.
- **Linked orders:** never re-read; their lines are never changed automatically.

**Recovery dry run** (`scripts/recover-shopify-order-sync.ts <id>`) plans from the same fresh state and prints:

- the current financial status, and the stored webhook's status when it is outdated;
- payment eligibility (Product-Only: `paid` or `partially_refunded`);
- per refunded line: ordered, refunded, excluded, remaining and fulfilled quantity;
- any refund ambiguity;
- the lines to send and the exact planned KiotViet `totalPayment`.

It blocks when Shopify cannot be read, the order is cancelled, it is not paid, or a refund is ambiguous. For an already linked order it prints a read-only `RECONCILE (manual, never automatic)` line for every SKU whose KiotViet quantity differs from Shopify's current effective quantity. Apply stays guarded by the order advisory lock, the planned mapping version and a deterministic job ID, so repeated attempts enqueue at most one job and never a second order.


## Payment: the invoice never creates a payment

The POST always sends `totalPayment: 0`. The existing KiotViet order payment is never altered, refunded or duplicated.

| KiotViet prepayment vs invoice | Result |
| --- | --- |
| equal + sandbox evidence `carried` + `invoicePrepaymentVerified` | created; policy `verified` |
| equal + `allowUnverifiedPrepaymentInheritance` (acknowledged) | created; policy `unverified_accepted`; payment checked on the created invoice |
| equal, neither | `blocked: prepayment_inheritance_unverified` |
| prepayment > invoice | `blocked: prepayment_exceeds_invoice` (see `prepaymentExceedsInvoicePolicy`) |
| prepayment < invoice / none | `blocked: prepayment_below_invoice` / `kiotviet_payment_missing` |

Right after the POST, the returned invoice ID is saved (`needs_review` until verified). Then the invoice is read back and `reconciliation.paymentVerification` records `expectedPaid`, `invoiceTotalPayment`, `paymentRowsTotal`, `invoiceTotal`, `remainingBalance` and `discrepancies`:

- `verified`: KiotViet reports exactly the prepayment as paid, the payment rows add up, and the remaining balance is 0. The invoice can be `created`.
- `mismatch`: **informational** (`blocking: false`). Shopify Paid decides that the customer paid. The invoice is `created` if its identity, lines, completed status, merchandise-only total and stock movement are verified. `paymentVerification` keeps KiotViet's own amounts (`kiotVietInvoiceFullyPaid`, `remainingBalance`, `discrepancies`), so the system never claims the KiotViet invoice is paid when KiotViet says otherwise. A warning `kiotviet_invoice_payment_discrepancy` is logged. No payment is ever sent to make it match, and the invoice is never created again.

`needs_review` is reserved for technical uncertainty: unknown invoice identity, wrong lines or total, an invoice that is not completed, unverified stock movement, or an incomplete duplicate lookup. Its `last_error` starts with `invoice_verification_failed:` (payment differences are only appended as information).

## Duplicate lookup (`findKiotVietInvoicesForOrder`)

An empty result is proof of absence only when completeness was established for every invoice that existed when the lookup began (`complete: true`). Times come from the PostgreSQL clock, so workers compare the same clock. The steps:

1. **Local, PostgreSQL only** (`localInvoiceCandidates`): one indexed query over `invoice_mappings` (by `kiotviet_order_id` / `kiotviet_order_code`) and `kiotviet_invoice_index` (by `order_code`). These are candidates, never proof.
2. **Completeness**, with the fewest requests:
   - **reused** (0 requests): another job or worker already confirmed the index current with a request that started after this lookup began.
   - **joined** (0 requests): an in-flight confirmation in the same process is awaited. Concurrent jobs share one tail request.
   - **fetched** (usually 1 request): the tail page is re-read with an overlap of 1.
   - **floor_scan** (usually 1 request): used when the index lags by more than 500 invoices, for orders this app created (see below).
   - A confirmation older than the lookup is never reused.
3. **Re-read** only the candidates found, so their status (active or cancelled) is current. A 404 removes the cached entry instead of reporting a duplicate.

The normal path for a new order is therefore 1 local query (plus the clock and the index state) and 0–1 KiotViet requests.

**`GET /invoices?orderId=` is never proof.** Its semantics are not documented. `scripts/verify-kiotviet-invoice-order-filter.ts` measures them (read-only; `--record` stores the result) and reports `filters`, `ignored` or `inconclusive`. Even with `filters`, the lookup asks the filter only when completeness failed, as an extra source of invoices to link, matched on `orderCode`. With `ignored`, the request is skipped.

**POST timeout**: the row stays `creating` (outcome unknown) and the POST is never resent. The job then searches with the same lookup, with bounded exponential backoff (1 s, 2 s, 4 s, 8 s; override with `INVOICE_UNCERTAIN_POLL_MS`, at most 10 delays of at most 60 s):

- **Exactly one invoice found:** its ID is saved immediately (inside the claim's advisory lock, and only while this attempt still owns the row) and it goes through normal verification. If another worker already settled the row, nothing is changed. If the search that found it was incomplete, it stays `needs_review`.
- **Two or more invoices:** `needs_review`, linking neither.
- **None found:** still `creating`. Later job retries re-plan and link it once it is visible. After the 5-minute window, `invoice_outcome_unknown` goes to manual review (`--reset-uncertain` is operator-only).

Unchanged safety: advisory lock plus claim token on the invoice claim, the `UNIQUE` constraints on `kiotviet_invoice_id` / `kiotviet_order_id` / `shopify_order_id`, the pre-POST re-check, and the stale-snapshot refusal.

**Metrics** are stored in `reconciliation.duplicateLookup` (plan) and `reconciliation.prePostLookup`: `localMs`, `remoteMs`, `totalMs`, `apiCalls`, `freshness`, `method`, `candidates`, `indexLag`. Admin shows the PostgreSQL P95, the total average and P95, requests per lookup, and the share of shared confirmations. The `planned` stage log carries the same fields.

**Measured** (development machine; real PostgreSQL engine via PGlite in-process, so there is no network round trip; all 13 migrations applied; 20,000 indexed invoices; 8,000 order and invoice mappings). Before → after:

| Measure | Before | After |
| --- | --- | --- |
| Index page write (100 invoices + checkpoint) | 101 statements, p50 32.0 ms / p95 34.7 ms | 1 statement, p50 1.6 ms / p95 2.3 ms |
| Index page through `advanceInvoiceIndex` (module code) | — | 2.5 ms per page |
| Local lookup step | 3 statements, p50 0.98 ms / p95 1.62 ms | 1 statement (`localLookupSnapshot`), p50 0.57 ms / p95 0.90 ms |
| Full lookup, KiotViet mocked as instant (app overhead only) | — | p50 2.8 ms / p95 4.1 ms |
| `UNION`+`OR` vs `UNION ALL` 3 branches (candidates) | hit 0.48 / miss 0.40 ms | 0.41 / 0.39 ms, worse max: **kept** `UNION`+`OR` |
| `invoice_mappings` update with / without the `updated_at` index | p50 0.42 ms | 0.39 ms, ~8% smaller: **dropped** (013) |
| Stock-retry scan, with / without a partial index | 1.24 ms | 0.94 ms: **no index** (once a minute) |

`EXPLAIN ANALYZE` uses a BitmapOr over `invoice_mappings_kiotviet_order_id_key` and `invoice_mappings_kiotviet_order_code_idx`, plus `kiotviet_invoice_index_order_code_idx` (execution 0.22 ms). Each saved statement also saves a network round trip on a real connection.

Refresh sharing: concurrent lookups join an in-flight refresh. A lookup that starts after a refresh began waits for it, then shares **one queued refresh** with every other late arrival (`freshness: "queued"`) instead of sending its own request. A test shows 3 lookups → 2 KiotViet requests. Across separate processes, sharing goes through `current_as_of` (`reused`); PM2 runs one worker process.

A networked `pg` connection adds its round-trip time per query. The remote part (0–1 KiotViet requests) was **not** measured: it depends on KiotViet's response time and is not assumed to be under 1 s. Measure both on staging or production with:

```bash
npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts --iterations 1000   # PostgreSQL only, read-only
npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts --remote 5           # + 5 full lookups (KiotViet GETs only)
```

## Duplicate detection without waiting for the index

When the app claims a Shopify order for KiotViet order creation (before the KiotViet order exists), it stores `order_mappings.invoice_id_floor` = the highest indexed invoice id. Every invoice of that order must have a larger id. So the job proves "no invoice yet" by reading invoices newest-first until it reaches an id ≤ floor (normally 1 request). Each page must be strictly ordered by id. Each later page re-reads the previous page's last invoice, so an insert, delete or ignored ordering during the scan makes it inconclusive, never complete. With more than 500 invoices above the floor, the job falls back to the full index. Orders linked by recovery, or recovered after a timed-out order POST, have no floor and always use the index. The final re-check right before the POST is unchanged.

Index writes: each page is persisted with **one statement**. A data-modifying CTE advances the guarded checkpoint (`generation` + `scanned_count`) and batch-UPSERTs the page with `unnest(...)` + `ON CONFLICT(invoice_id) DO UPDATE`; `DISTINCT ON` makes duplicate ids in a page safe. Rows are written only if the checkpoint matched, and the checkpoint only moves with its rows, so a crash or error changes neither and the page is re-read. A concurrent runner waits on the state row lock, then matches nothing and writes nothing. Cancelled invoices are stored with their status (candidates are re-read anyway).

Index maintenance: an overlap mismatch is repaired by binary-search repositioning (no full rebuild). Scheduled runs hold a lease (`lease_owner/lease_until`), so they never overlap. Each run reads at most 30 pages. Jobs without a floor are deferred cheaply while the index lags and are re-admitted once it is current. Lag and staleness are shown in Admin.

## Latency and state

Each job stores `reconciliation.timings`: `triggerReceivedAt` (fulfillment webhook arrival), `admittedAt`, `jobStartedAt`, per-stage `…At`/`…Ms` (`triggerChecked`, `planned`, `invoiceApplied`, `inventorySynchronized`), `queueMs`, `invoiceLatencyMs` (webhook → verified invoice, the SLO measure) and `totalLatencyMs` (including stock). Admin → Settings and Admin → Hóa đơn show the average, the P95 and the share within 60 s over 7 days. Targets (5–30 s typical, 95% ≤ 60 s) are goals; nothing has been measured in production yet.

One Shopify read per job was removed: the planner reuses the job's live state, and the pre-apply check compares the settings version. Shopify changes are still caught by apply's fresh order snapshot.

Stock sync is independent of invoice creation. A failure is stored in `reconciliation.shopifyStockSynchronized=false` with `stockRetryAt` (5 min × 2ⁿ, max 6 h), and the minute scheduler retries only the stock push. Shopify receives absolute KiotViet on-hand, never a decrement, so retries cannot deduct twice. A stock failure never overwrites a `needs_review` invoice's payment error.

## Rollout (VPS + PM2; operator procedure, not executed)

```bash
cd /var/www/shopify-kiotviet
pg_dump "$DATABASE_URL" -Fc -f "backup-$(date +%F-%H%M).dump"
pm2 stop shopify-kiotviet-worker shopify-kiotviet-scheduler shopify-kiotviet-web
# install the reviewed release (git pull / rsync)
npm ci
npx tsx --env-file=.env.production scripts/migrate.ts        # applies 010–013 if not yet applied
npm run typecheck && npm test && npm run build
NODE_OPTIONS="--env-file=/var/www/shopify-kiotviet/.env.production" pm2 restart ecosystem.config.js --update-env
pm2 save
pm2 logs shopify-kiotviet-worker --lines 100
npx tsx --env-file=.env.production scripts/build-kiotviet-invoice-index.ts --status
# Read-only checks after the deploy:
npx tsx --env-file=.env.production scripts/benchmark-invoice-lookup.ts --iterations 1000
npx tsx --env-file=.env.production scripts/verify-kiotviet-invoice-order-filter.ts            # add --record to store the result
```

Migration 012 creates three plain indexes inside the migration transaction. On these table sizes that takes seconds, but it locks writes to `invoice_mappings` and `order_mappings` while building, so run it with the worker stopped (as above). Rollback: `database/rollback/012_invoice_lookup_indexes.down.sql` (indexes only). Migration 013 drops `invoice_mappings_updated_at_idx` (rollback `013_drop_invoice_updated_at_index.down.sql` recreates it). The worker setting `INVOICE_UNCERTAIN_POLL_MS` (optional, default exponential `1000,2000,4000,8000`) goes in `.env.production`.

Then, in Admin → Settings:

1. Keep `shopify_fulfilled` and `USD`. Tick **Product-Only Invoicing** and save.
2. Decide with accounting about **Allow Unverified Prepayment Inheritance**. Enable it only after reading and ticking the confirmation.
3. Watch the first new Paid + Fulfilled order with the queries below: one invoice, `paymentVerification.status`, `stockVerified`, `shopifyStockSynchronized`, `timings`.
4. If its payment shows `mismatch`, the invoice is still `created` and stock is synced. Accounting settles the KiotViet balance manually. If that is not acceptable for future orders, turn the policy off; new prepaid orders are then blocked again instead of being invoiced.

Rollback, fastest first:

1. Untick **Allow Unverified Prepayment Inheritance**.
2. Untick **Product-Only** (strict rules apply immediately).
3. Set the trigger to Disabled.
4. Redeploy the previous release and run `database/rollback/011_invoice_automation.down.sql`, then `010_…down.sql` if needed.

Invoices already created stay in KiotViet and keep their audit.

## Verification queries (read-only)

```sql
-- #1071 / #1082 and any new order
SELECT shopify_order_id,shopify_order_number,kiotviet_order_id,kiotviet_order_code,status,invoice_id_floor,invoice_check_at
FROM order_mappings WHERE shopify_order_id IN ('7107364880568','7133915545784');

SELECT shopify_order_id,kiotviet_order_code,kiotviet_invoice_id,kiotviet_invoice_code,status,error_code,failure_stage,last_error,
  reconciliation->'productOnly'->>'prepaymentPolicy' AS prepayment_policy,
  reconciliation->'productOnly'->>'invoiceMerchandise' AS invoice_merchandise,
  reconciliation->'productOnly'->>'shopifyPaid' AS shopify_paid,
  reconciliation->'productOnly'->>'kiotVietPrepaid' AS kiotviet_prepaid,
  reconciliation->'paymentVerification' AS payment_verification,
  reconciliation->'productOnly'->'differences' AS differences,
  reconciliation->>'stockVerified' AS stock_verified, reconciliation->>'shopifyStockSynchronized' AS shopify_stock_synced,
  reconciliation->'timings' AS timings
FROM invoice_mappings WHERE shopify_order_id IN ('7107364880568','7133915545784');

SELECT id,status,attempts,max_attempts,error_code,error,payload->>'triggerState' AS trigger_state,
  payload->>'receivedAt' AS received_at,payload->>'admittedAt' AS admitted_at,created_at,completed_at
FROM sync_jobs WHERE type='shopify_invoice_create' AND payload->>'entityId' IN ('7107364880568','7133915545784') ORDER BY created_at;

-- Duplicate-lookup performance (last 7 days): latency, KiotViet requests, shared freshness
SELECT count(*),percentile_cont(0.95) WITHIN GROUP (ORDER BY (l->>'localMs')::float8) AS local_p95_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (l->>'totalMs')::float8) AS total_p95_ms,
  avg((l->>'apiCalls')::float8) AS api_calls_avg, count(*) FILTER (WHERE l->>'freshness' IN ('reused','joined')) AS shared
FROM invoice_mappings, LATERAL (VALUES (reconciliation->'duplicateLookup'),(reconciliation->'prePostLookup')) v(l)
WHERE invoiced_at>now()-interval '7 days' AND jsonb_typeof(l)='object';

-- Invoices linked automatically after a timed-out POST
SELECT shopify_order_id,kiotviet_invoice_code,status,reconciliation->'uncertainPost' FROM invoice_mappings WHERE reconciliation ? 'uncertainPost';

-- Indexes used by the local lookup
SELECT indexname FROM pg_indexes WHERE tablename IN ('invoice_mappings','order_mappings','kiotviet_invoice_index') ORDER BY 1;

-- Duplicate guard: both must return no rows
SELECT kiotviet_order_id,count(*) FROM invoice_mappings WHERE kiotviet_invoice_id IS NOT NULL GROUP BY 1 HAVING count(*)>1;
SELECT kiotviet_invoice_id,count(*) FROM invoice_mappings WHERE kiotviet_invoice_id IS NOT NULL GROUP BY 1 HAVING count(*)>1;

-- What blocks automation now
SELECT status,error_code,failure_stage,count(*) FROM invoice_mappings WHERE kiotviet_invoice_id IS NULL GROUP BY 1,2,3 ORDER BY 4 DESC;

-- Payment inheritance observed on created invoices (evidence for accounting)
SELECT reconciliation->'productOnly'->>'prepaymentPolicy' AS policy,reconciliation->'paymentVerification'->>'status' AS payment,count(*)
FROM invoice_mappings WHERE kiotviet_invoice_id IS NOT NULL GROUP BY 1,2;
SELECT shopify_order_id,kiotviet_invoice_code,reconciliation->'paymentVerification'->'discrepancies'
FROM invoice_mappings WHERE reconciliation->'paymentVerification'->>'status'='mismatch';

-- Stock sync pending/failed
SELECT shopify_order_id,reconciliation->>'stockSyncAttempts' AS attempts,reconciliation->>'stockRetryAt' AS retry_at,reconciliation->>'shopifyStockError' AS error
FROM invoice_mappings WHERE reconciliation->>'shopifyStockSynchronized'='false';

-- Latency SLO (last 7 days)
SELECT count(*),round(avg(ms)) AS avg_ms,round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) AS p95_ms,
  round(100.0*count(*) FILTER (WHERE ms<=60000)/NULLIF(count(*),0),1) AS pct_within_60s
FROM (SELECT (reconciliation->'timings'->>'invoiceLatencyMs')::numeric AS ms FROM invoice_mappings
  WHERE invoiced_at>now()-interval '7 days' AND reconciliation->'timings' ? 'invoiceLatencyMs') t;

-- Index health
SELECT scanned_count,remote_total,remote_total-scanned_count AS lag,current_as_of,generation,reset_count,reposition_count,lease_owner,lease_until,last_error
FROM kiotviet_invoice_index_state;
```

## #1071 and #1082 (dry runs only)

Automation never backfills orders created before `invoiceTriggerEnabledAt`; such orders need an explicit recovery action:

```bash
npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts 7107364880568 7133915545784
```

- **#1082 / DH031389**: the dry run is expected to show invoice 202, Shopify paid 210.42, `processing_fee_excluded 8.42` and additional payment 0.
  - With `allowUnverifiedPrepaymentInheritance` on, the plan is `create one invoice`. Only then would `--apply` create it, and its payment is then recorded as `verified` or `mismatch` (informational; status follows identity, lines and stock).
  - Otherwise it stays `blocked: prepayment_inheritance_unverified`.
- **#1071 / DH031121**: invoice 154 against a 164 prepayment, with `shipping_excluded 10`. Always `blocked: prepayment_exceeds_invoice`. Under `prepaymentExceedsInvoicePolicy: manual_override` it can go through the admin override (stays `needs_review`). The 10 USD is never changed, deleted, duplicated or refunded.

These expectations come from unit-test fixtures built from the reported totals (the split into product lines is illustrative). No live dry run was executed.

## Remaining risks

1. **Unverified inheritance is a business decision.** With the policy on, an invoice can be created before KiotViet's behavior is known. If KiotViet does not carry the prepayment, every such invoice is `created` but shows unpaid in KiotViet (`paymentVerification.status = mismatch`) until accounting settles it. The first invoice reveals the behavior: check it before leaving the policy on.
2. **The floor scan and the index both assume** KiotViet allocates increasing invoice ids and honors `orderBy=id` (checked on every page). A staff invoice created between the final check and the POST is still possible (see `docs/fulfillment-invoices.md`).
3. **Overpaid historical orders (#1071)**, **added product tax** and **KiotViet orders that already carry a surcharge** still need people.
4. **Latency targets are unmeasured.** Real values depend on KiotViet/Shopify response times and rate limits; Admin now shows them.
5. **The migrations were not run against a real PostgreSQL in development**; run them in staging first.
