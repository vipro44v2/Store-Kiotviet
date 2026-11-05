# KiotViet returns → Shopify financial refunds

Implementation: `lib/sync/return-sync.ts`. Migration: `014_refund_state_and_invoice_payment_status.sql`.

## States (`refund_mappings.status`, one row per KiotViet return)

| Status | Meaning | Automation |
| --- | --- | --- |
| `processing` | Claimed by one worker; validating; **nothing sent** | A claim older than 15 min is reclaimed |
| `sending` | `refundCreate` sent, or its outcome is unknown | **Never sent again.** Only reconciled: a Shopify refund whose note is `Returned and refunded from KiotViet (<code>).` is linked |
| `financial_refunded` | Shopify refund id recorded (`source`: `created` or `recovered`) | Done |
| `needs_review` | Evidence insufficient or outcome unknown | No automatic money movement |
| `failed` | Definitely not sent (validation, or Shopify `userErrors`) | A later run may try again |

Before Shopify is called, the row stores the exact request (`request`), the deterministic `idempotency_key` (sha256 of `kiotviet-financial-return:<id>`, also sent as Shopify's `@idempotent` key) and `sent_at`. PostgreSQL transactions only cover the claim and the state changes; no HTTP call runs inside one.

`needs_review` reasons (`last_error`):

- `existing_refund_unverified`: the order has a refund that may already cover this return (same SKU, or a money-only refund made around or after the return), and nothing proves it. A matching SKU and quantity is not proof of payment.
- `duplicate_refunds`: two refunds carry this return's note.
- `refund_outcome_unknown`: `refundCreate` was sent and no refund appeared within 10 minutes.
- `no_payment_returned`: KiotViet recorded no money paid back (`totalPayment` = 0).
- `insufficient_refundable_payment`: Shopify has less refundable payment than requested; no partial refund is made.
- A linked refund whose amount differs from the return: the refund id is saved, and no further refund is made.

Resolving a `needs_review` row: check the order's refunds in Shopify.

- **Already refunded:** record it.

  ```sql
  UPDATE refund_mappings SET status='financial_refunded', financial_refund_id='<gid>', shopify_refund_id='<gid>', source='manual', claim_token=NULL, updated_at=now() WHERE kiotviet_return_id=<id>;
  ```

- **Definitely not refunded, and a refund is wanted:** let the job try again.

  ```sql
  UPDATE refund_mappings SET status='failed', claim_token=NULL, updated_at=now() WHERE kiotviet_return_id=<id> AND financial_refund_id IS NULL;
  ```

  Then run `npx tsx --env-file=.env.production scripts/sync-kiotviet-return.ts <id>`.

## Deployment (VPS + PM2; not executed)

```bash
cd /var/www/shopify-kiotviet
pg_dump "$DATABASE_URL" -Fc -f "backup-$(date +%F-%H%M).dump"
pm2 stop shopify-kiotviet-worker shopify-kiotviet-scheduler shopify-kiotviet-web
# install the reviewed release (git pull / rsync)
npm ci
npx tsx --env-file=.env.production scripts/migrate.ts          # applies 014 (additive)
npm run typecheck && npm test && npm run build
NODE_OPTIONS="--env-file=/var/www/shopify-kiotviet/.env.production" pm2 restart ecosystem.config.js --update-env
pm2 save
pm2 logs shopify-kiotviet-worker --lines 100
```

Before restarting, check for branch→location sharing; inventory writes for such branches now stop with a ConflictError:

```sql
SELECT shopify_location_id, array_agg(kiotviet_branch_id) FROM branch_location_mappings WHERE enabled GROUP BY 1 HAVING count(*) > 1;
```

## Verification queries (read-only)

```sql
-- Refund attempts that are not finished, and why
SELECT kiotviet_return_id, kiotviet_return_code, status, attempt_count, sent_at, last_error FROM refund_mappings
WHERE status IN ('processing','sending','needs_review','failed') ORDER BY updated_at DESC;

-- Duplicate guards: all must return no rows
SELECT financial_refund_id, count(*) FROM refund_mappings WHERE financial_refund_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
SELECT kiotviet_return_id, count(*) FROM refund_mappings WHERE kiotviet_return_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
SELECT shopify_order_id, kiotviet_return_code, count(*) FROM refund_mappings WHERE status='financial_refunded' GROUP BY 1, 2 HAVING count(*) > 1;

-- Invoices: existence vs payment verification
SELECT status, payment_status, count(*) FROM invoice_mappings WHERE kiotviet_invoice_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
SELECT shopify_order_id, kiotviet_invoice_code, payment_status, reconciliation->'paymentVerification' FROM invoice_mappings
WHERE payment_status IN ('mismatch','unverified') ORDER BY updated_at DESC;
```

## Rollback

1. Stop the worker and scheduler, then redeploy the previous release.
2. Resolve rows without a Shopify refund id first. Pre-014 code requires `shopify_refund_id`, and a `sending` row may correspond to a real Shopify refund, so verify each in Shopify:

   ```sql
   SELECT kiotviet_return_id, status, last_error FROM refund_mappings WHERE shopify_refund_id IS NULL;
   ```

3. Run `database/rollback/014_refund_state_and_invoice_payment_status.down.sql`. It stops if unresolved rows remain and never deletes them. The new columns are kept for audit.
