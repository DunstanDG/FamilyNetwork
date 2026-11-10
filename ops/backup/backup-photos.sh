#!/usr/bin/env bash
# Copies the Immich library to the second disk, then the second disk offsite.
# Run nightly after Immich's own database backup, e.g.  45 2 * * *  /opt/family/ops/backup/backup-photos.sh
#
# In /etc/family-backup.env:
#   IMMICH_LIBRARY=/srv/immich/library          # Immich's UPLOAD_LOCATION
#   IMMICH_DB_BACKUPS=/srv/immich/library/backups   # Immich writes nightly DB dumps here (Admin -> Settings -> Backup)
#   PHOTO_BACKUP_DIR=/mnt/backup/family/immich
#   RCLONE_REMOTE=offsite:family-immich          # an rclone remote with encryption (rclone "crypt"), set up once with `rclone config`
#   IMMICH_MOUNT=/srv/immich                     # optional: the mount point the library lives on
#   BACKUP_MOUNT=/mnt/backup                     # optional: the second disk's mount point
#   MIN_KEEP_PERCENT=90                          # refuse to mirror if the library shrank below this share of the backup
#
# Safety: this mirrors (and so deletes from the copy), so it refuses to run when the library looks
# missing: disk not mounted, library empty, or far smaller than last night's copy. Run with
# FORCE=1 once if you really did delete a lot of photos on purpose.
set -euo pipefail
# shellcheck disable=SC1091
source /etc/family-backup.env
: "${IMMICH_LIBRARY:?}" "${PHOTO_BACKUP_DIR:?}"

fail() { echo "photo backup REFUSED: $*" >&2; exit 1; }
command -v rsync >/dev/null || fail "rsync is not installed (apt install rsync)"

# 1. The disks are really there (an unmounted mount point is just an empty folder).
for m in "${IMMICH_MOUNT:-}" "${BACKUP_MOUNT:-}"; do
  [[ -z "$m" ]] || mountpoint -q "$m" || fail "$m is not mounted"
done
[[ -d "$IMMICH_LIBRARY" ]] || fail "$IMMICH_LIBRARY does not exist"

# 2. The library has originals in it.
originals="$IMMICH_LIBRARY/upload"
[[ -d "$IMMICH_LIBRARY/library" ]] && originals="$IMMICH_LIBRARY/library $originals"
# shellcheck disable=SC2086
src_count=$( { find $originals -type f 2>/dev/null || true; } | wc -l)
(( src_count > 0 )) || fail "no original photos found under $IMMICH_LIBRARY"

# 3. It hasn't suddenly shrunk compared with the copy (a half-mounted disk, a bad restore...).
mkdir -p "$PHOTO_BACKUP_DIR/library"
dst_count=$( { find "$PHOTO_BACKUP_DIR/library/upload" "$PHOTO_BACKUP_DIR/library/library" -type f 2>/dev/null || true; } | wc -l)
min_pct="${MIN_KEEP_PERCENT:-90}"
if [[ "${FORCE:-0}" != 1 ]] && (( dst_count > 0 )) && (( src_count * 100 < dst_count * min_pct )); then
  fail "library has $src_count files but the copy has $dst_count; check it, then re-run with FORCE=1 if that's expected"
fi
# Originals, plus Immich's own DB dumps. Thumbnails and encoded video are rebuilt by Immich, so skipped.
rsync -a --delete-after --exclude 'thumbs/' --exclude 'encoded-video/' "$IMMICH_LIBRARY/" "$PHOTO_BACKUP_DIR/library/"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  # Same check for the offsite copy: --max-delete stops a sync that would remove more than a few files
  # (a deliberate big clear-out needs FORCE=1).
  max_delete=$([[ "${FORCE:-0}" == 1 ]] && echo -1 || echo 200)
  # Never --delete offsite straight away: keep removed files for 30 days in case of a mistake.
  rclone sync "$PHOTO_BACKUP_DIR/library" "$RCLONE_REMOTE/library" \
    --backup-dir "$RCLONE_REMOTE/removed/$(date -u +%Y-%m-%d)" --fast-list --transfers 4 --max-delete "$max_delete"
  rclone delete "$RCLONE_REMOTE/removed" --min-age 30d --rmdirs || true
  # The database dumps too, so the offsite copy alone is enough to rebuild.
  [[ -n "${BACKUP_DIR:-}" ]] && rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE/db" --max-age 2d
fi
echo "photo backup ok: $(du -sh "$PHOTO_BACKUP_DIR/library" | cut -f1)"
