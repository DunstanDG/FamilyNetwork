// The migrations can be run again (for example after one stopped part-way in the SQL editor) without
// errors and without losing anything.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ADULT, actor, applyMigration, makeDb, seedPeople } from './helpers.js';

const LATER = ['0002_feeds.sql', '0003_photos.sql', '0004_calendar.sql', '0005_hardening.sql'];

describe('re-running migrations', () => {
  it('runs 0002-0005 a second time over a database with data in it', async () => {
    const db = await makeDb();
    await seedPeople(db);
    const { as, rows, service } = actor(db);
    await as(ADULT, (tx) => tx.exec(`insert into family.posts (id, kind) values ('50000000-0000-4000-8000-000000000001', 'photo_album')`));
    await service(`select family.record_photo('50000000-0000-4000-8000-000000000001', '${ADULT}', 'imm-1', 1, 1, null, 0)`);

    for (const m of LATER) await applyMigration(db, m);

    expect(await rows(ADULT, 'select immich_asset_id from family.photo_assets')).toEqual([{ immich_asset_id: 'imm-1' }]);
    // Rules still in force after the second run.
    await as(ADULT, (tx) => tx.exec(`insert into family.posts (kind) values ('photo_album')`));
    await expect(as(ADULT, (tx) => tx.exec(`insert into family.posts (kind) values ('digest')`))).rejects.toThrow();
    const policies = await db.query(`select count(*)::int as n from pg_policies where schemaname = 'family' and policyname = 'posts_insert'`);
    expect(policies.rows[0].n).toBe(1);
    const pub = await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'photo_assets'`);
    expect(pub.rows).toHaveLength(1);
  });

  it('finishes 0003 when an earlier attempt stopped after creating photo_assets', async () => {
    const db = await makeDb({ upTo: 2 });
    const sql = readFileSync(new URL('../../supabase/migrations/0003_photos.sql', import.meta.url), 'utf8');
    // Everything up to (but not including) the comments foreign key: the table exists, the rest doesn't.
    await db.exec(sql.slice(0, sql.indexOf('do $$ begin\n  if not exists (select 1 from pg_constraint where conname = \'comments_photo_asset_id_fkey\'')));
    await applyMigration(db, '0003_photos.sql');
    await applyMigration(db, '0004_calendar.sql');
    await applyMigration(db, '0005_hardening.sql');
    const fk = await db.query(`select 1 from pg_constraint where conname = 'comments_photo_asset_id_fkey'`);
    expect(fk.rows).toHaveLength(1);
    const fn = await db.query(`select 1 from pg_proc where proname = 'record_photo'`);
    expect(fn.rows).toHaveLength(1);
  });
});
