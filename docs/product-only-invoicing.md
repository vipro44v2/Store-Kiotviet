# Product-Only Invoicing

Extends the existing Shopify → KiotViet invoice pipeline (`docs/fulfillment-invoices.md`).
Nothing was deployed and no production record was changed while implementing this.

## What changes when the mode is on

Admin → Settings → **Product-Only Invoicing** writes these keys under `system_settings.orders`:

| Key | Selected default | Meaning |
| --- | --- | --- |
| `productOnlyInvoicing` | `true` | Orders and invoices carry product merchandise only |
| `paymentSource` | `"shopify"` | Shopify's live financial status decides "customer paid" |
| `excludeShipping` | `true` | Shipping (and its tax) is never on the order/invoice; recorded as a difference |
| `excludeProcessingFees` | `true` | Processing-fee lines are recorded as a difference |
| `excludeOtherSurcharges` | `true` | Tips and other non-product charges are recorded as a difference |
| `ignoreFinancialMismatch` | `true` | A Shopify total *above* the merchandise does not block |

Existing installations stay strict: migration 010 writes only `productOnlyInvoicing:false` and `paymentSource:"shopify"`. Selecting the mode turns every flag on unless an admin turns one off; a flag that is off makes that category block again. The mode requires an explicit Invoice Creation Trigger (`shopify_paid` or `shopify_fulfilled`); the trigger and its activation timestamp are never changed by the migration.

**New orders** (created after the mode is on): KiotViet order lines use the discounted unit price (`discount: 0`), no shipping surcharge is added, and `totalPayment` is the merchandise paid. A discount that cannot be split into whole cents per unit keeps the list price; that order's invoice is then blocked (`discount_not_representable`).

**Invoice**: `invoiceTotal = Σ discounted unit price × quantity` of the existing KiotViet order lines. Existing (historical) KiotViet orders are invoiced from their own lines and are never altered. The POST always sends `totalPayment: 0`.

**Payment safety** (`lib/sync/product-only-invoicing.ts → productOnlyPaymentDecision`). The invoice never creates a payment. Only one case is automatic:

| KiotViet order prepayment vs invoice | Result |
| --- | --- |
| equal, and inheritance verified (sandbox evidence `carried` + `orders.invoicePrepaymentVerified`) | invoice created; must report exactly the prepayment as paid |
| equal, inheritance not verified | `blocked: prepayment_inheritance_unverified` |
| prepayment > invoice (e.g. shipping prepaid on an older order) | `blocked: prepayment_exceeds_invoice` |
| prepayment < invoice | `blocked: prepayment_below_invoice` |
| no prepayment | `blocked: kiotviet_payment_missing` |

The blocked cases can still be invoiced one order at a time through the existing admin override; the remaining difference keeps such an invoice `needs_review`.

**Still blocking in Product-Only mode**: unmapped/ambiguous SKUs, quantity or price differences against the KiotViet order, invalid seller, cancelled orders, product refunds, added product tax, currency mismatch, a Shopify total below the merchandise, a surcharge already on the KiotViet order (undocumented whether it would be copied onto the invoice), duplicate or cancelled invoices, an uncertain previous POST, and an inconclusive duplicate lookup.

**No longer blocking**: `unsupported_shipping`, `shipping_not_on_kiotviet_order`, `shipping_mismatch`, shipping-caused `total_mismatch`, processing fees, tips and other surcharges. They are stored in `invoice_mappings.reconciliation.productOnly.differences` (with Shopify paid amount, invoice merchandise, KiotViet prepayment and payment source) and `reconciliation.financiallyReconciled` stays `false`. They do not turn a verified invoice into `needs_review`.

Post-creation checks are unchanged except that the invoice total must equal the merchandise and carry no surcharge: branch, lines/quantities/prices, order code, completed status, total, payment = carried prepayment, payment rows, and the branch stock movement. Any failure → `needs_review` with the invoice ID kept. Then KiotViet stock is pushed to Shopify (absolute quantities, existing locks).

## Invoice index automation

- An overlap mismatch (invoices deleted in KiotViet) no longer rebuilds 13k+ invoices: the scan position is re-located by binary search (≈ log₂(total) single-row reads), keeping the index. Only a remote list that is not sorted by id still forces a full rebuild.
- A cached invoice that KiotViet answers 404 for is removed from the index instead of failing every lookup.
- While the index lags by more than 500 invoices, an invoice job is **deferred** before any remote read (`blocked`, `failure_stage='invoice_index'`, `invoice_index_not_ready`). Attempts in `pending`/`creating` are never deferred; they keep the retry → link/review path.
- The scheduler's `kiotviet_invoice_index` job (every minute) re-admits deferred orders once the index is current — once per deferral.
- Orders whose invoice jobs keep exhausting their retries are re-checked at 30 min × 2ⁿ (max 24 h).
- A stale index (not current for 15 min) is logged (`invoice_index_stale`) and shown on Admin → Hóa đơn.
- Duplicate protection is unchanged: no invoice is created unless the lookup is complete.

## Status values

Admin → Hóa đơn shows each order's status, `error_code`, `failure_stage`, merchandise and Shopify-paid amounts. `invoice_mappings.status` maps to: `pending`, `creating` (shown as **processing**: POST sent or possibly sent, never resent automatically), `created`, `blocked` (not eligible, nothing sent), `needs_review`, `failed` (definitely not created, safe to retry). Each workflow stage logs `invoice_stage_<name>` (`trigger_ready`, `deferred_for_index`, `planned`, `applied`, `inventory_synchronized`).

## Deployment (VPS + PM2; operator procedure, not executed)

Back up PostgreSQL first. Migration 010 is additive (one generated column, one index, four counters).

```bash
cd /var/www/shopify-kiotviet
pm2 stop shopify-kiotviet-worker shopify-kiotviet-scheduler shopify-kiotviet-web
# install the reviewed release with your normal process (git pull / rsync)
npm ci
npx tsx --env-file=.env.production scripts/migrate.ts
npm run typecheck && npm test && npm run build
NODE_OPTIONS="--env-file=/var/www/shopify-kiotviet/.env.production" pm2 restart ecosystem.config.js --update-env
pm2 save
pm2 logs shopify-kiotviet-worker --lines 100
npx tsx --env-file=.env.production scripts/build-kiotviet-invoice-index.ts --status
```

Then, in Admin → Settings: keep the current trigger, tick **Product-Only Invoicing**, save. Watch the first new order end to end before relying on it unattended.

Rollback: untick the mode (strict rules apply again immediately), or redeploy the previous release and run `database/rollback/010_product_only_invoicing.down.sql`. Invoices already created keep their audit in `reconciliation.productOnly`.

## Verification queries (read-only)

```sql
-- Order and invoice for one Shopify order
SELECT shopify_order_id,shopify_order_number,kiotviet_order_id,kiotviet_order_code,status,sync_status,invoice_check_at
FROM order_mappings WHERE shopify_order_id IN ('7107364880568','7133915545784');

SELECT shopify_order_id,kiotviet_order_code,kiotviet_invoice_id,kiotviet_invoice_code,status,error_code,failure_stage,last_error,
  reconciliation->>'invoicingMode' AS mode,
  reconciliation->'productOnly'->>'invoiceMerchandise' AS invoice_merchandise,
  reconciliation->'productOnly'->>'shopifyPaid' AS shopify_paid,
  reconciliation->'productOnly'->>'kiotVietPrepaid' AS kiotviet_prepaid,
  reconciliation->'productOnly'->'differences' AS differences,
  reconciliation->'checks' AS checks, reconciliation->>'stockVerified' AS stock_verified,
  reconciliation->>'shopifyStockSynchronized' AS shopify_stock_synced
FROM invoice_mappings WHERE shopify_order_id IN ('7107364880568','7133915545784');

SELECT id,status,attempts,max_attempts,error_code,error,payload->>'triggerState' AS trigger_state,created_at,completed_at
FROM sync_jobs WHERE type='shopify_invoice_create' AND payload->>'entityId' IN ('7107364880568','7133915545784')
ORDER BY created_at;

-- Overview: what blocks automatic invoicing right now
SELECT status,error_code,failure_stage,count(*) FROM invoice_mappings
WHERE kiotviet_invoice_id IS NULL GROUP BY 1,2,3 ORDER BY 4 DESC;

-- Duplicate guard: must return no rows
SELECT kiotviet_order_id,count(*) FROM invoice_mappings WHERE kiotviet_invoice_id IS NOT NULL GROUP BY 1 HAVING count(*)>1;

-- Index health
SELECT scanned_count,remote_total,current_as_of,generation,reset_count,reposition_count,last_error FROM kiotviet_invoice_index_state;

-- Product-Only invoices whose financial differences remain open (expected; for accounting)
SELECT shopify_order_id,kiotviet_invoice_code,reconciliation->'productOnly'->'differences' FROM invoice_mappings
WHERE status='created' AND reconciliation->>'invoicingMode'='product_only' AND reconciliation->>'financiallyReconciled'='false';
```

## #1071 and #1082 (dry runs only)

An order created before the trigger's `invoiceTriggerEnabledAt` is never picked up by automation and needs an explicit recovery action. Dry run first (read-only):

```bash
npx tsx --env-file=.env.production scripts/recover-kiotviet-invoice.ts 7107364880568 7133915545784
```

- **#1071 / DH031121**: expected output `invoice_merchandise=154 kiotviet_prepaid=164`, differences `shipping_excluded 10` and `kiotviet_prepaid_vs_invoice 10`, plan `blocked: prepayment_exceeds_invoice`. KiotViet holds 164 paid against a 154 product invoice; how it carries the extra 10 is unverified, so this needs accounting's decision (admin override, which stays `needs_review`) or a correction of the KiotViet payment first.
- **#1082 / DH031389**: expected `invoice_merchandise=202 kiotviet_prepaid=202`. Blocked only by `prepayment_inheritance_unverified` (plus `invoice_lookup_incomplete` until the index is current). Once the inheritance evidence is recorded and accounting signs off, the dry run shows `create one invoice … additional payment 0`; only then run the same command with `--apply`.

These expectations come from unit-test fixtures built from the reported totals; no live dry run was executed.

## Remaining safety blockers

1. **Prepayment inheritance is unverified.** KiotViet does not document whether an invoice created from an order (POST /invoices with `orderId`) inherits the order's prepayment. Until `scripts/verify-kiotviet-prepayment-inheritance.ts` records `carried` on a **sandbox** retailer and accounting sets `orders.invoicePrepaymentVerified`, every prepaid order — i.e. every normal paid order — stays `blocked`. This is the main gate to unattended invoicing.
2. **Prepayment ≠ merchandise** (orders created before Product-Only, where KiotViet recorded shipping in the prepayment, like #1071) is never invoiced automatically; the over-carry behavior is untested.
3. **Added product tax** still blocks. Tax is not a surcharge; dropping it silently was out of scope.
4. **KiotViet orders that already carry a surcharge** block, because it is undocumented whether the invoice copies it.
5. **Index soundness** still rests on KiotViet allocating increasing invoice ids and honoring `orderBy=id` (checked on every page; a violation forces a rebuild and blocks invoicing meanwhile).
6. **Cross-system races**: a staff member can still create an invoice between the final lookup and the POST; Product-Only does not change this (see `docs/fulfillment-invoices.md`).
