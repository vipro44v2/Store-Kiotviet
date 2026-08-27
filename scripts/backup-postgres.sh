#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR="/var/backups/shopify-kiotviet"
mkdir -p "$BACKUP_DIR"
umask 077
pg_dump --format=custom --no-owner --file="$BACKUP_DIR/shopify-kiotviet-$(date +%F-%H%M%S).dump" "$DATABASE_URL"
find "$BACKUP_DIR" -type f -name 'shopify-kiotviet-*.dump' -mtime +30 -delete
