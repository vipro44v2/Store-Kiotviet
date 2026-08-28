# Shopify KiotViet Sync

Nền tảng đồng bộ Shopify ↔ KiotViet chạy độc lập trên Ubuntu VPS. Hệ thống gồm Next.js web/API, PostgreSQL lưu dữ liệu nghiệp vụ, Redis/BullMQ cho background jobs, worker và scheduler riêng.

## Kiến trúc

```text
Shopify Admin GraphQL + Shopify Webhooks ─┐
                                         ├→ Nginx → Next.js API → PostgreSQL
KiotViet Public API + KiotViet Webhooks ─┘                   ↓
                                                        Redis/BullMQ
                                                             ↓
                                              Worker → provider APIs
```

KiotViet mặc định là nguồn SKU/tồn kho; Shopify là storefront và nguồn đơn online. Mapping dùng persistent mapping trước, sau đó exact normalized SKU. SKU trùng hoặc thiếu luôn chuyển conflict/manual review, không match theo title.

## Chức năng

- Webhook Shopify và KiotViet xác minh raw-body HMAC, lưu event trước khi enqueue, deduplicate bằng provider/webhook ID.
- BullMQ queues: `sync`, `webhooks`, `reconciliation`, `maintenance`; metadata job được audit trong PostgreSQL.
- Cache token KiotViet trong Redis và refresh trước hạn 60 giây.
- Shopify GraphQL client có timeout, throttling/cost awareness và retry lỗi tạm thời.
- Mapping engine, inventory absolute sync, safety stock, branch → location mapping, compare-and-set.
- Shopify orders/customers → KiotViet; đơn thiếu mapping chuyển manual review.
- Refund, fulfillment hoặc chiều sync không đủ dữ liệu/mapping an toàn được giữ manual review, không bị bỏ qua.
- Admin login bằng signed HTTP-only SameSite cookie; CSRF origin checks và Redis login rate limit.
- Dashboard: products, mappings, inventory, orders, customers, jobs, conflicts, webhooks, logs, notifications, settings.
- Health check theo dõi DB, Redis, queue, worker heartbeat, Shopify và KiotViet.
- PM2, Nginx HTTPS, backup script, migrations và tests.

## Yêu cầu

- Node.js 22 LTS
- PostgreSQL 16+
- Redis 7+
- Linux VPS cho production; Windows/macOS dùng được để phát triển

## Local development

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run db:seed
npm run dev
```

Để test webhook local, Redis là bắt buộc để request chỉ enqueue BullMQ và trả về nhanh. Chạy PostgreSQL/Redis, web và worker ở các terminal riêng:

```bash
docker compose up -d postgres redis
npx tsx --env-file=.env.local scripts/migrate.ts
npm run dev
npm run worker
```

Không để trống `REDIS_URL` khi test webhook. Chế độ inline chỉ phù hợp phát triển các chức năng không liên quan webhook.

- Catalog: http://localhost:3000
- Admin: http://localhost:3000/admin
- Health: http://localhost:3000/api/health

Các lệnh kiểm tra:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run health:check
```

Nếu máy local có Docker, có thể khởi động riêng PostgreSQL/Redis bằng `docker compose up -d`; production không phụ thuộc Docker.

## Test webhook local qua Cloudflare Tunnel

Giữ Next.js chạy tại `http://localhost:3000`, sau đó mở tunnel ở terminal khác:

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare in ra một URL ngẫu nhiên dạng `https://abc.trycloudflare.com`. Cập nhật `.env.local` (không hardcode URL này trong code), rồi restart web và worker:

```env
APP_URL=http://localhost:3000
PUBLIC_APP_URL=https://abc.trycloudflare.com
REDIS_URL=redis://127.0.0.1:6379
```

Đăng ký URL sau trong KiotViet:

```text
https://abc.trycloudflare.com/api/webhooks/kiotviet
```

Route xác minh `X-Hub-Signature`, ghi event vào PostgreSQL, log payload đã che token/secret/signature/email/phone/address và chỉ enqueue vào BullMQ. Worker xử lý sync ngoài request. Route cũ `/api/kiotviet/webhooks` vẫn được giữ để tương thích.

Test chữ ký và đường truyền trực tiếp qua localhost:

```bash
npm run webhooks:test:kiotviet
```

Test qua tunnel:

```bash
npm run webhooks:test:kiotviet -- https://abc.trycloudflare.com
```

Script dùng payload `stock.update` rỗng nên xác minh đầy đủ HTTP/HMAC/PostgreSQL/BullMQ mà không thay đổi tồn kho thật. Kết quả mong đợi là HTTP `200` với `success: true`.

## Environment variables

Xem `.env.example`. Các secret bắt buộc chỉ nằm ở server:

```env
NODE_ENV=production
APP_URL=https://sync.example.com
PUBLIC_APP_URL=https://sync.example.com
APP_PORT=3000
DATABASE_URL=postgresql://shopify_sync:STRONG_PASSWORD@127.0.0.1:5432/shopify_kiotviet
DATABASE_POOL_MIN=1
DATABASE_POOL_MAX=10
REDIS_URL=redis://127.0.0.1:6379
SHOPIFY_SHOP=store
SHOPIFY_CLIENT_ID=xxx
SHOPIFY_CLIENT_SECRET=xxx
SHOPIFY_API_VERSION=2026-07
KIOTVIET_CLIENT_ID=xxx
KIOTVIET_CLIENT_SECRET=xxx
KIOTVIET_RETAILER=shopqt
KIOTVIET_WEBHOOK_SECRET=BASE64_SECRET
SESSION_SECRET=AT_LEAST_32_RANDOM_CHARACTERS
ADMIN_USERNAME=admin
ADMIN_PASSWORD=STRONG_PASSWORD
WORKER_CONCURRENCY=3
JOB_MAX_ATTEMPTS=5
LOG_LEVEL=info
```

Production processes gọi validation và dừng ngay nếu thiếu biến bắt buộc. Không dùng prefix `NEXT_PUBLIC_` cho credentials.

## Database

Migration `database/migrations/001_initial.sql` tạo:

`integrations`, `product_mappings`, `branch_location_mappings`, `order_mappings`, `customer_mappings`, `fulfillment_mappings`, `refund_mappings`, `webhook_events`, `sync_jobs`, `sync_logs`, `inventory_snapshots`, `sync_conflicts`, `audit_logs`, `system_settings`, `notifications`, `worker_heartbeats`, `sync_checkpoints`, `schema_migrations`.

Migration chạy transaction và ghi lịch sử:

```bash
npm run db:migrate
npm run db:seed
```

Luôn chạy `pg_dump` trước migration có rủi ro. Migration production phải forward-safe; không xóa/đổi kiểu cột trong cùng lần deploy code phụ thuộc cột cũ.

## Shopify configuration

Tạo/cài app cho store và cấp tối thiểu:

```text
read_products, write_products
read_inventory, write_inventory
read_locations
read_orders
read_customers, write_customers
read_fulfillments, write_fulfillments
```

Điền shop handle, Client ID và Client Secret. Access token được lấy tự động bằng client credentials, cache trong Redis và refresh trước khi hết hạn. Sau đó đăng ký topics:

```bash
npm run webhooks:register
```

Topics: orders create/update/cancel, refunds create, fulfillments create/update, products create/update/delete, inventory levels update, customers create/update, app uninstalled.

Webhook URL có dạng `https://sync.example.com/api/shopify/webhooks/orders_create`. Shopify HMAC được kiểm tra bằng `SHOPIFY_CLIENT_SECRET` trên raw body.

## KiotViet configuration

Trong Thiết lập kết nối API, lấy Client ID/Client Secret/Retailer. Tạo random secret tối thiểu 32 bytes và Base64 hóa:

```bash
openssl rand -base64 32
```

Đăng ký webhook chính:

```http
POST https://public.kiotapi.com/webhooks
Authorization: Bearer KIOTVIET_TOKEN
Retailer: shopqt
Content-Type: application/json

{"Webhook":{"Type":"stock.update","Url":"https://sync.example.com/api/kiotviet/webhooks","IsActive":true,"Description":"Shopify inventory synchronization","Secret":"BASE64_SECRET"}}
```

Endpoint xác minh `X-Hub-Signature`. KiotViet yêu cầu phản hồi dưới 5 giây; route chỉ persist/enqueue rồi trả về, worker xử lý sau.

Đăng ký thêm webhook thay đổi sản phẩm (ví dụ `product.update`) vào cùng URL. Sự kiện sản phẩm sẽ tự lấy bản ghi đầy đủ từ KiotViet rồi upsert title, mô tả, loại, trạng thái, SKU, giá, barcode và tồn kho sang Shopify. Sự kiện `stock.update` tiếp tục dùng luồng tồn kho riêng.

## Mapping branch/location

Sau khi lấy KiotViet branches và Shopify locations, tạo mapping trong `branch_location_mappings`. Mỗi mapping có `enabled` và `safety_stock`. Công thức mặc định:

```text
Shopify available = max(0, KiotViet onHand - reserved - safety_stock)
```

Chạy `Initialize mappings` trong Admin, xử lý duplicate/missing SKU, cấu hình `orders.defaultBranchId`, sau đó mới reconciliation.

## Ubuntu 24.04 VPS

### 1. Tạo user và cài hệ thống

```bash
sudo adduser shopify-sync
sudo usermod -aG sudo shopify-sync
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl ufw postgresql postgresql-contrib redis-server certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Đăng nhập bằng SSH key cho `shopify-sync`; sau khi xác minh key hoạt động mới tắt password authentication trong SSH. Không chạy app bằng root.

### 2. PostgreSQL

```bash
sudo -u postgres psql
CREATE USER shopify_sync WITH PASSWORD 'STRONG_UNIQUE_PASSWORD';
CREATE DATABASE shopify_kiotviet OWNER shopify_sync;
\q
```

Giữ PostgreSQL listen ở localhost/private network. App không dùng postgres superuser.

### 3. Redis

Trong `/etc/redis/redis.conf`, giữ `bind 127.0.0.1 ::1`, `protected-mode yes`; đặt password nếu Redis dùng private network chia sẻ. Sau đó:

```bash
sudo systemctl enable --now postgresql redis-server nginx
```

### 4. Deploy

```bash
sudo mkdir -p /var/www/shopify-kiotviet /var/log/shopify-kiotviet /var/backups/shopify-kiotviet
sudo chown -R shopify-sync:shopify-sync /var/www/shopify-kiotviet /var/log/shopify-kiotviet /var/backups/shopify-kiotviet
sudo -iu shopify-sync
git clone YOUR_REPOSITORY_URL /var/www/shopify-kiotviet
cd /var/www/shopify-kiotviet
cp .env.example .env
chmod 600 .env
nano .env
npm ci
npm run db:migrate
npm run db:seed
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Chạy command mà `pm2 startup` in ra bằng sudo để bật auto-start.

### 5. Nginx và SSL

Đổi `sync.example.com` trong `nginx/shopify-kiotviet.conf`, rồi:

```bash
sudo cp nginx/shopify-kiotviet.conf /etc/nginx/sites-available/shopify-kiotviet
sudo ln -s /etc/nginx/sites-available/shopify-kiotviet /etc/nginx/sites-enabled/shopify-kiotviet
sudo nginx -t
sudo certbot --nginx -d sync.example.com
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

### 6. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Không mở port 5432 hoặc 6379 ra Internet.

## PM2 và monitoring

```bash
pm2 status
pm2 logs shopify-kiotviet-web
pm2 logs shopify-kiotviet-worker
pm2 logs shopify-kiotviet-scheduler
curl -fsS https://sync.example.com/api/health
```

Health báo `worker: stale` nếu heartbeat quá 45 giây. PM2 tự restart process crash và giới hạn bộ nhớ theo `ecosystem.config.js`.

## Backup và restore

```bash
chmod +x scripts/backup-postgres.sh
DATABASE_URL='postgresql://...' scripts/backup-postgres.sh
crontab -e
0 2 * * * DATABASE_URL='postgresql://...' /var/www/shopify-kiotviet/scripts/backup-postgres.sh
```

Restore test định kỳ:

```bash
createdb shopify_kiotviet_restore_test
pg_restore --no-owner --dbname=shopify_kiotviet_restore_test /var/backups/shopify-kiotviet/FILE.dump
dropdb shopify_kiotviet_restore_test
```

Giữ tối thiểu 7 daily và 4 weekly snapshots ở hệ thống backup; sao chép off-server và kiểm tra restore. Script mặc định xóa file quá 30 ngày.

## Retention

Mặc định trong `system_settings.retention`: webhook/completed jobs 30 ngày, sync logs 90 ngày, audit logs 180 ngày. Failed/manual-review được giữ đến khi xử lý. Scheduler maintenance thực thi theo cấu hình deployment.

## Update, rollback và zero-downtime

```bash
cd /var/www/shopify-kiotviet
git pull --ff-only
npm ci
npm run db:migrate
npm run build
pm2 reload ecosystem.config.js
```

Trước update: backup DB và ghi lại commit hiện tại. Rollback code bằng deploy lại commit đã xác minh rồi `npm ci && npm run build && pm2 reload`; không rollback migration phá hủy dữ liệu. Viết migration bù forward nếu schema cần sửa.

## Troubleshooting

- `401 webhook`: kiểm tra API secret/Base64 webhook secret và raw body không bị proxy sửa.
- Jobs pending: kiểm tra Redis, worker PM2 và `/api/health`.
- Manual review: sửa mapping/branch/default order branch rồi retry job từ admin.
- Shopify `403`: app thiếu scope hoặc scope mới chưa được merchant approve.
- KiotViet `401`: kiểm tra Client ID/Secret/Retailer; token cache tự refresh và retry một lần.
- Inventory mutation lỗi: variant phải tracked và được stock tại location đã map.
- Duplicate SKU: không tự chọn; resolve trong `/admin/conflicts`.

## Giới hạn KiotViet chính thức

KiotViet hỗ trợ product/customer/order REST và webhook `stock.update`. Một số chuyển đổi refund, fulfillment và status không có phép ánh xạ một-một an toàn cho mọi cấu hình cửa hàng. Hệ thống giữ payload, tạo manual-review và notification thay vì tự đoán endpoint/payload hoặc bỏ qua sự kiện.

## Production checklist

- [ ] Dedicated non-root user và SSH key đã xác minh
- [ ] UFW chỉ mở SSH/HTTP/HTTPS
- [ ] Nginx HTTPS/HSTS hoạt động
- [ ] PostgreSQL/Redis không public
- [ ] Strong secrets, `.env` mode 600
- [ ] Migration và seed thành công
- [ ] Backup và restore test thành công
- [ ] PM2 startup sau reboot
- [ ] Worker heartbeat healthy
- [ ] Shopify/KiotViet connection healthy
- [ ] Shopify HMAC và KiotViet HMAC đã test
- [ ] Branch/location/default order branch đã map
- [ ] Duplicate SKU đã resolve
- [ ] Initial mapping/reconciliation hoàn tất
- [ ] Order, cancellation, refund/manual-review đã test
- [ ] Retry, worker restart và server reboot đã test
