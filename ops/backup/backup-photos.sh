#!/usr/bin/env bash
# Copies the Immich library to the second disk, then the second disk offsite.
# Run nightly after Immich's own database backup, e.g.  45 2 * * *  /opt/family/ops/backup/backup-photos.sh
#
# In /etc/family-backup.env:
#   IMMICH_LIBRARY=/srv/immich/library          # Immich's UPLOAD_LOCATION
#   IMMICH_DB_BACKUPS=/srv/immich/library/backups   # Immich writes nightly DB dumps here (Admin -> Settings -> Backup)
#   PHOTO_BACKUP_DIR=/mnt/backup/family/immich
#   RCLONE_REMOTE=offsite:family-immich          # an rclone remote with encryption (rclone "crypt"), set up once with `rclone config`
set -euo pipefail
# shellcheck disable=SC1091
source /etc/family-backup.env
: "${IMMICH_LIBRARY:?}" "${PHOTO_BACKUP_DIR:?}"

mkdir -p "$PHOTO_BACKUP_DIR"
# Originals, plus Immich's own DB dumps. Thumbnails and encoded video are rebuilt by Immich, so skipped.
rsync -a --delete-after --exclude 'thumbs/' --exclude 'encoded-video/' "$IMMICH_LIBRARY/" "$PHOTO_BACKUP_DIR/library/"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  # Never --delete offsite straight away: keep removed files for 30 days in case of a mistake.
  rclone sync "$PHOTO_BACKUP_DIR/library" "$RCLONE_REMOTE/library" \
    --backup-dir "$RCLONE_REMOTE/removed/$(date -u +%Y-%m-%d)" --fast-list --transfers 4
  rclone delete "$RCLONE_REMOTE/removed" --min-age 30d --rmdirs || true
  # The database dumps too, so the offsite copy alone is enough to rebuild.
  [[ -n "${BACKUP_DIR:-}" ]] && rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE/db" --max-age 2d
fi
echo "photo backup ok: $(du -sh "$PHOTO_BACKUP_DIR/library" | cut -f1)"
