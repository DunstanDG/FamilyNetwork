#!/usr/bin/env bash
# Nightly dump of the Family Network data (the `family` schema and the sign-in users it points at).
# Run on the Proxmox box from cron, e.g.  15 2 * * *  /opt/family/ops/backup/backup-db.sh
#
# Needs: pg_dump 17+ (apt install postgresql-client-17), and in /etc/family-backup.env:
#   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
#   BACKUP_DIR=/mnt/backup/family/db          # on the second disk
#   KEEP_DAYS=35
set -euo pipefail
# shellcheck disable=SC1091
source /etc/family-backup.env
: "${SUPABASE_DB_URL:?}" "${BACKUP_DIR:?}"
KEEP_DAYS="${KEEP_DAYS:-35}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y-%m-%dT%H%MZ)"
out="$BACKUP_DIR/family-$stamp.dump"

# Custom format: compressed, and restorable table by table.
pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
  --schema=family --file="$out.partial"
# The auth users that family.profiles refers to (ids and emails only), so a restore can re-link them.
psql "$SUPABASE_DB_URL" -At -c "copy (select u.id, u.email from auth.users u join family.profiles p on p.id = u.id) to stdout with csv" \
  > "$BACKUP_DIR/family-users-$stamp.csv"
mv "$out.partial" "$out"

find "$BACKUP_DIR" -name 'family-*' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $out ($(du -h "$out" | cut -f1))"
