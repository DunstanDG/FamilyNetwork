// Filtered YouTube search: who can see and change what, the admin's final word, the review queue,
// the daily allowance and the nightly clear-down.
import { describe, it, expect, beforeAll } from 'vitest';
import { ADMIN, ADULT, CHILD, STRANGER, actor, denied, makeDb, seedPeople } from './helpers.js';

const CH = (n) => `UC${String(n).padStart(22, 'a')}`;
const VID = (n) => String(n).padStart(11, 'v');

describe('filtered YouTube search', () => {
  let db; let as; let rows; let service;
  beforeAll(async () => {
    db = await makeDb();
    await seedPeople(db);
    ({ as, rows, service } = actor(db));
    await service(`insert into family.yt_channels (channel_id, title, title_at, tier, reason, source, confidence) values
      ('${CH(1)}', 'Garden Hour', now(), 'trusted', 'fine', 'model', 0.9),
      ('${CH(2)}', 'Truth Uncovered', now(), 'caution', 'conspiracy', 'model', 0.7),
      ('${CH(3)}', 'Being checked', now(), 'checking', '', 'pending', null)`);
  });

  it('lets family members read verdicts, and nobody else', async () => {
    expect(await rows(CHILD, 'select channel_id from family.yt_channels order by 1')).toHaveLength(3);
    expect(await rows(STRANGER, 'select channel_id from family.yt_channels')).toHaveLength(0);
    await denied(as(null, (tx) => tx.query('select 1 from family.yt_channels'), 'anon'));
  });

  it('keeps verdicts out of ordinary members’ hands', async () => {
    expect(await rows(ADULT, `update family.yt_channels set tier = 'trusted' where channel_id = '${CH(2)}' returning channel_id`)).toHaveLength(0);
    await denied(as(ADULT, (tx) => tx.query(`insert into family.yt_channels (channel_id, tier) values ('${CH(8)}', 'trusted')`)));
    await denied(as(ADMIN, (tx) => tx.query(`delete from family.yt_channels where channel_id = '${CH(1)}'`)));
    expect((await service(`select tier from family.yt_channels where channel_id = '${CH(2)}'`))[0].tier).toBe('caution');
  });

  it('keeps the cache, the allowance and other people’s activity private', async () => {
    await service(`insert into family.yt_search_cache (query_key, results, expires_at) values ('roses', '[]', now() + interval '1 day')`);
    await denied(as(ADMIN, (tx) => tx.query('select 1 from family.yt_search_cache')));
    await denied(as(ADMIN, (tx) => tx.query('select 1 from family.yt_quota')));
    await denied(as(ADULT, (tx) => tx.query('select family.yt_take_quota(90)')));
    await denied(as(ADULT, (tx) => tx.query('select family.yt_clear_down()')));
  });

  it('records plays and ratings as the person who made them', async () => {
    await as(ADULT, (tx) => tx.query(`insert into family.yt_activity (kind, video_id, channel_id) values ('play', '${VID(1)}', '${CH(1)}'), ('like', '${VID(1)}', '${CH(1)}')`));
    expect(await rows(ADULT, 'select kind from family.yt_activity order by id')).toEqual([{ kind: 'play' }, { kind: 'like' }]);
    expect(await rows(CHILD, 'select kind from family.yt_activity')).toHaveLength(0);
    expect(await rows(ADMIN, 'select kind from family.yt_activity')).toHaveLength(0);
    // Nobody can write as someone else, write a search, or mark their own rows as exported.
    await denied(as(ADULT, (tx) => tx.query(`insert into family.yt_activity (user_id, kind, video_id, channel_id) values ('${CHILD}', 'play', '${VID(1)}', '${CH(1)}')`)));
    await denied(as(ADULT, (tx) => tx.query(`insert into family.yt_activity (kind, query) values ('search', 'roses')`)));
    await denied(as(ADULT, (tx) => tx.query(`update family.yt_activity set exported_at = now()`)));
    await denied(as(STRANGER, (tx) => tx.query(`insert into family.yt_activity (kind, video_id, channel_id) values ('play', '${VID(1)}', '${CH(1)}')`)));
    await denied(as(ADULT, (tx) => tx.query(`insert into family.yt_activity (kind, video_id, channel_id) values ('play', 'bad id', '${CH(1)}')`)));
  });

  it('puts a thumbs-down in front of admins once, however many arrive', async () => {
    await as(ADULT, (tx) => tx.query(`insert into family.yt_activity (kind, video_id, channel_id) values ('dislike', '${VID(2)}', '${CH(2)}')`));
    await as(CHILD, (tx) => tx.query(`insert into family.yt_activity (kind, video_id, channel_id) values ('dislike', '${VID(3)}', '${CH(2)}')`));
    // A channel nobody has searched for yet still gets a row to hang the review on.
    await as(CHILD, (tx) => tx.query(`insert into family.yt_activity (kind, video_id, channel_id) values ('dislike', '${VID(4)}', '${CH(4)}')`));
    const open = await rows(ADMIN, 'select channel_id, why, raised_by from family.yt_reviews where resolved_at is null order by channel_id');
    expect(open).toEqual([
      { channel_id: CH(2), why: 'dislike', raised_by: ADULT },
      { channel_id: CH(4), why: 'dislike', raised_by: CHILD },
    ]);
    expect(await rows(ADULT, 'select 1 from family.yt_reviews')).toHaveLength(0);
    expect((await service(`select tier, source from family.yt_channels where channel_id = '${CH(4)}'`))[0]).toEqual({ tier: 'checking', source: 'pending' });
  });

  it('makes an admin’s verdict theirs, and settles what was waiting on it', async () => {
    const [row] = await rows(ADMIN, `update family.yt_channels set tier = 'blocked' where channel_id = '${CH(2)}' returning tier, reason, source, decided_by, confidence`);
    expect(row).toEqual({ tier: 'blocked', reason: 'admin', source: 'admin', decided_by: ADMIN, confidence: null });
    expect(await rows(ADMIN, `select 1 from family.yt_reviews where channel_id = '${CH(2)}' and resolved_at is null`)).toHaveLength(0);
    const [done] = await service(`select resolved_by from family.yt_reviews where channel_id = '${CH(2)}'`);
    expect(done.resolved_by).toBe(ADMIN);
    // An admin picks a verdict; "checking" isn't one, and other columns aren't theirs to set.
    await denied(as(ADMIN, (tx) => tx.query(`update family.yt_channels set tier = 'checking' where channel_id = '${CH(1)}'`)));
    await denied(as(ADMIN, (tx) => tx.query(`update family.yt_channels set note = 'x' where channel_id = '${CH(1)}'`)));
  });

  it('never lets the automatic check overwrite an admin', async () => {
    await service(`update family.yt_channels set tier = 'trusted', reason = 'fine', source = 'model', confidence = 0.99, title = 'Renamed' where channel_id = '${CH(2)}'`);
    const [row] = await service(`select tier, reason, source, confidence, title from family.yt_channels where channel_id = '${CH(2)}'`);
    expect(row).toEqual({ tier: 'blocked', reason: 'admin', source: 'admin', confidence: null, title: 'Renamed' });
    // Everything else is the function's to write.
    await service(`update family.yt_channels set tier = 'caution', reason = 'new_channel', source = 'model' where channel_id = '${CH(3)}'`);
    expect((await service(`select tier from family.yt_channels where channel_id = '${CH(3)}'`))[0].tier).toBe('caution');
  });

  it('counts uncached searches against a daily allowance', async () => {
    const take = async (cap) => (await service('select family.yt_take_quota($1) as ok', [cap]))[0].ok;
    expect(await take(2)).toBe(true);
    expect(await take(2)).toBe(true);
    expect(await take(2)).toBe(false);
    expect(await take(2)).toBe(false);
    expect((await service('select searches from family.yt_quota'))[0].searches).toBe(2);
    expect(await take(3)).toBe(true);
  });

  it('clears down what is finished with, and keeps verdicts', async () => {
    await service(`insert into family.yt_search_cache (query_key, results, expires_at) values ('old', '[]', now() - interval '1 hour')`);
    await service(`insert into family.yt_activity (user_id, kind, video_id, channel_id, created_at, exported_at) values
      ('${ADULT}', 'play', '${VID(5)}', '${CH(1)}', now() - interval '8 days', now() - interval '7 days'),
      ('${ADULT}', 'play', '${VID(6)}', '${CH(1)}', now() - interval '8 days', null),
      ('${ADULT}', 'play', '${VID(7)}', '${CH(1)}', now() - interval '2 days', now() - interval '1 day'),
      ('${ADULT}', 'play', '${VID(8)}', '${CH(1)}', now() - interval '91 days', null)`);
    await service(`update family.yt_reviews set resolved_at = now() - interval '31 days' where channel_id = '${CH(2)}'`);
    await service(`update family.yt_channels set title_at = now() - interval '31 days' where channel_id = '${CH(1)}'`);
    await service(`insert into family.yt_quota (day, searches) values (current_date - 40, 12)`);
    const before = (await service('select count(*)::int as n from family.yt_channels'))[0].n;

    const [{ report }] = (await db.query('select family.yt_clear_down() as report')).rows;
    expect(report).toEqual({ cache: 1, activity: 2, reviews: 1, titles: 1, quota: 1 });

    expect((await service(`select query_key from family.yt_search_cache`)).map((r) => r.query_key)).toEqual(['roses']);
    const left = (await service(`select video_id from family.yt_activity where video_id in ('${VID(5)}', '${VID(6)}', '${VID(7)}', '${VID(8)}') order by 1`)).map((r) => r.video_id);
    expect(left).toEqual([VID(6), VID(7)]);       // not yet exported, and exported too recently to drop
    expect((await service('select count(*)::int as n from family.yt_channels'))[0].n).toBe(before);
    const [named] = await service(`select title, tier from family.yt_channels where channel_id = '${CH(1)}'`);
    expect(named).toEqual({ title: null, tier: 'trusted' });
  });

  it('sends verdicts over Realtime', async () => {
    const pub = await db.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'family' and tablename = 'yt_channels'`);
    expect(pub.rows).toHaveLength(1);
  });

  it('leaves outsiders nothing new to call', async () => {
    const callable = async (role) => (await db.query(`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'family' and p.proname like 'yt\\_%' and has_function_privilege($1, p.oid, 'execute') order by 1`, [role])).rows.map((r) => r.name);
    expect(await callable('anon')).toEqual([]);
    expect(await callable('authenticated')).toEqual([]);
    expect(await callable('service_role')).toEqual(['yt_take_quota']);
  });
});
