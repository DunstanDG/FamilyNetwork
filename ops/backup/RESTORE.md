# Test restore (the Phase 3 gate)

Do this once before relying on the backups, then every few months. It restores into a scratch
Postgres and a scratch Immich, so nothing live is touched.

## Database

```bash
docker run -d --name restore-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17
export TEST_DB=postgresql://postgres:test@localhost:55432/postgres
latest=$(ls -t /mnt/backup/family/db/family-*.dump | head -1)

# The dump expects Supabase's auth schema and roles; give it minimal stand-ins.
psql "$TEST_DB" -c "create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql as 'select null::uuid';"
users=$(ls -t /mnt/backup/family/db/family-users-*.csv | head -1)
psql "$TEST_DB" -c "\copy auth.users (id, email) from '$users' csv"
pg_restore --no-owner --dbname="$TEST_DB" "$latest"

psql "$TEST_DB" -c "select count(*) as posts from family.posts;
  select count(*) as photos from family.photo_assets;
  select max(created_at) as newest from family.posts;"
docker rm -f restore-pg
```

Pass: counts match the live app (roughly; anything since 2am won't be there) and `newest` is from
yesterday.

## Photos

1. Pick three photo ids from the restored database:
   `select immich_asset_id from family.photo_assets order by random() limit 3;`
2. Start a scratch Immich pointed at the backup copy:
   - copy Immich's `docker-compose.yml` and `.env` to `/tmp/immich-restore`, set
     `UPLOAD_LOCATION=/mnt/backup/family/immich/library`, change the published port to 2284
   - restore Immich's own database dump from `library/backups/` as its docs describe
     (Immich docs → Administration → Backup and Restore)
   - open `http://<proxmox-ip>:2284/photos/<asset-id>` for each of the three and check it opens at full size
3. Repeat step 2 from the offsite copy at least once a year (`rclone copy offsite:family-immich/library /tmp/offsite-test`).

Write the date and result here:

| Date | Database | Photos (second disk) | Photos (offsite) | By |
| --- | --- | --- | --- | --- |
| | | | | |
