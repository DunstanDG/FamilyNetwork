#!/usr/bin/env bash
# Hands the filtered YouTube search's activity to the home server's data retention system, and keeps
# a copy of every channel verdict. Run on the Proxmox box from cron, after the nightly dump, e.g.
#   45 2 * * *  /opt/family/ops/backup/export-video-activity.sh
#
# Writes two kinds of file into RETENTION_DIR, one JSON object per line:
#   video-activity-<stamp>.jsonl   what was played and rated since the last run (and what was
#                                  searched for, if the yt-search function has YT_LOG_SEARCHES=true)
#   video-verdicts-<stamp>.jsonl   every channel verdict as it stands (ids and our own labels only;
#                                  no names or other YouTube data)
# Rows are marked as exported only after their file is safely written; Supabase's nightly clear-down
# then deletes exported rows after 7 days. If this script stops running, nothing is lost for 90 days.
# A crash between writing and marking repeats those rows next time: de-duplicate on "id".
#
# Needs: psql 17+, and in /etc/family-backup.env (as backup-db.sh):
#   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
#   RETENTION_DIR=/mnt/retention/inbox/family-video     # wherever the retention system picks files up
#   VERDICT_KEEP_DAYS=35                                # verdict snapshots to keep (activity files are never deleted here)
set -euo pipefail
# shellcheck disable=SC1091
source /etc/family-backup.env
: "${SUPABASE_DB_URL:?}" "${RETENTION_DIR:?}"
VERDICT_KEEP_DAYS="${VERDICT_KEEP_DAYS:-35}"

mkdir -p "$RETENTION_DIR"
stamp="$(date -u +%Y-%m-%dT%H%MZ)"
sql() { psql "$SUPABASE_DB_URL" -qAt -v ON_ERROR_STOP=1 "$@"; }

# Everything not yet exported, up to a fixed id, so rows arriving mid-run wait for the next one.
upto="$(sql -c "select coalesce(max(id), 0) from family.yt_activity where exported_at is null")"
[[ "$upto" =~ ^[0-9]+$ ]] || { echo "unexpected answer from the database: $upto" >&2; exit 1; }

rows=0
if [ "$upto" -gt 0 ]; then
  out="$RETENTION_DIR/video-activity-$stamp.jsonl"
  sql -c "select json_build_object('id', a.id, 'at', a.created_at, 'person', p.display_name, 'user_id', a.user_id,
                                   'kind', a.kind, 'query', a.query, 'video_id', a.video_id, 'channel_id', a.channel_id)
          from family.yt_activity a join family.profiles p on p.id = a.user_id
          where a.exported_at is null and a.id <= $upto order by a.id" > "$out.partial"
  rows="$(wc -l < "$out.partial" | tr -d ' ')"
  mv "$out.partial" "$out"
  sql -c "update family.yt_activity set exported_at = now() where exported_at is null and id <= $upto"
fi

verdicts="$RETENTION_DIR/video-verdicts-$stamp.jsonl"
sql -c "select json_build_object('channel_id', channel_id, 'tier', tier, 'reason', reason, 'topic', topic, 'confidence', confidence,
                                 'note', note, 'source', source, 'checked_at', checked_at)
        from family.yt_channels where tier in ('trusted', 'caution', 'blocked') order by channel_id" > "$verdicts.partial"
mv "$verdicts.partial" "$verdicts"
find "$RETENTION_DIR" -name 'video-verdicts-*.jsonl' -mtime +"$VERDICT_KEEP_DAYS" -delete

echo "export ok: $rows activity rows, $(wc -l < "$verdicts" | tr -d ' ') verdicts -> $RETENTION_DIR"
