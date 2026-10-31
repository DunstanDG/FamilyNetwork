// Phase 2: shared links and videos, followed sources, the poller's digest, playback, Family Feed import.
import { describe, it, expect, beforeAll } from 'vitest';
import { ADMIN, ADULT, CHILD, STRANGER, actor, denied, makeDb, seedPeople } from './helpers.js';

const CHANNEL = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv';
let db; let as; let rows; let service;

beforeAll(async () => {
  db = await makeDb();
  await seedPeople(db);
  ({ as, rows, service } = actor(db));
});

describe('sharing', () => {
  it('lets members share links, videos and episodes but not make system posts', async () => {
    for (const kind of ['link', 'video', 'podcast_episode']) {
      await as(ADULT, (tx) => tx.query(`insert into family.posts (kind, payload) values ($1, '{"url":"https://example.com"}')`, [kind]));
    }
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (kind) values ('digest')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (kind, author_id) values ('link', null)`)));
    await denied(as(STRANGER, (tx) => tx.exec(`insert into family.posts (kind) values ('link')`)));
  });

  it('cannot attach your post to a digest', async () => {
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (kind, digest_id) values ('link', gen_random_uuid())`)));
  });
});

describe('sources', () => {
  it('can be followed by any member, once, and only YouTube feeds of the right shape', async () => {
    await as(CHILD, (tx) => tx.query(`insert into family.sources (kind, feed_url, title) values ('youtube', $1, 'A channel')`, [CHANNEL]));
    await denied(as(ADULT, (tx) => tx.query(`insert into family.sources (kind, feed_url) values ('youtube', $1)`, [CHANNEL])));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.sources (kind, feed_url) values ('youtube', 'https://evil.example/feed')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.sources (kind, feed_url) values ('podcast', 'file:///etc/passwd')`)));
    await denied(as(STRANGER, (tx) => tx.exec(`insert into family.sources (kind, feed_url) values ('podcast', 'https://x.example/rss')`)));
    await as(ADULT, (tx) => tx.exec(`insert into family.sources (kind, feed_url, title) values ('podcast', 'https://pod.example/rss', 'A show')`));
    const all = await rows(CHILD, 'select kind, added_by from family.sources order by kind');
    expect(all).toEqual([{ kind: 'podcast', added_by: ADULT }, { kind: 'youtube', added_by: CHILD }]);
  });

  it('can only be unfollowed by whoever added it, or an admin', async () => {
    await as(ADULT, (tx) => tx.query('delete from family.sources where feed_url = $1', [CHANNEL]));
    expect(await rows(ADMIN, 'select 1 from family.sources where feed_url = $1', [CHANNEL])).toHaveLength(1);
    await denied(as(ADULT, (tx) => tx.exec(`update family.sources set etag = 'x'`)));
    await as(ADMIN, (tx) => tx.query('delete from family.sources where feed_url = $1', [CHANNEL]));
    expect(await rows(ADMIN, 'select 1 from family.sources where feed_url = $1', [CHANNEL])).toHaveLength(0);
  });
});

describe('the feed poller', () => {
  let source;
  beforeAll(async () => {
    [{ id: source }] = await service(`insert into family.sources (kind, feed_url, title) values ('podcast', 'https://pod2.example/rss', 'Pod Two') returning id`);
  });

  it('files new items under one digest a day and never twice', async () => {
    const add = (guid, post = true) => service(
      `select family.add_feed_item($1, $2, 'podcast_episode', $3::jsonb, $4) as id`,
      [source, guid, JSON.stringify({ title: `Episode ${guid}`, audio_url: 'https://pod2.example/e.mp3' }), post],
    );
    const [{ id: first }] = await add('ep-1');
    const [{ id: second }] = await add('ep-2');
    const [{ id: again }] = await add('ep-1');
    const [{ id: old }] = await add('ep-0', false);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(again).toBeNull();
    expect(old).toBeNull();

    const digests = await rows(ADULT, `select id, author_id, payload from family.posts where kind = 'digest'`);
    expect(digests).toHaveLength(1);
    expect(digests[0].author_id).toBeNull();
    const kids = await rows(ADULT, `select payload ->> 'source_id' as src from family.posts where digest_id = $1`, [digests[0].id]);
    expect(kids).toHaveLength(2);
    expect(kids[0].src).toBe(source);
    expect(await rows(ADULT, 'select guid from family.feed_items where source_id = $1 order by guid', [source]))
      .toEqual([{ guid: 'ep-0' }, { guid: 'ep-1' }, { guid: 'ep-2' }]);
  });

  it('is not callable by members', async () => {
    await denied(as(ADMIN, (tx) => tx.query(`select family.add_feed_item($1, 'x', 'video', '{}'::jsonb, true)`, [source])));
  });

  it('makes posts that take replies and reactions, but nobody can rewrite them', async () => {
    const [p] = await rows(ADULT, `select id from family.posts where kind = 'podcast_episode' and author_id is null limit 1`);
    await as(CHILD, (tx) => tx.query(`insert into family.comments (post_id, body) values ($1, 'love this one')`, [p.id]));
    await as(CHILD, (tx) => tx.query(`insert into family.reactions (post_id, emoji) values ($1, 'heart')`, [p.id]));
    await denied(as(ADMIN, (tx) => tx.query(`update family.posts set body = 'rewritten' where id = $1`, [p.id])));
    await as(ADMIN, (tx) => tx.query(`update family.posts set pinned = true where id = $1`, [p.id]));
    await as(ADMIN, (tx) => tx.query(`update family.posts set pinned = false where id = $1`, [p.id]));
    // a reply on a system post notifies nobody (there is no author)
    expect(await rows(ADMIN, `select 1 from family.notifications where post_id = $1`, [p.id])).toHaveLength(0);
  });
});

describe('playback', () => {
  it('is private to each person', async () => {
    const [p] = await rows(ADULT, `select id from family.posts where kind = 'podcast_episode' and author_id is null limit 1`);
    await as(ADULT, (tx) => tx.query('insert into family.playback (post_id, position_seconds, duration_seconds) values ($1, 120, 3600)', [p.id]));
    await as(ADULT, (tx) => tx.query('update family.playback set position_seconds = 200 where post_id = $1', [p.id]));
    expect(await rows(ADULT, 'select position_seconds::int as s from family.playback')).toEqual([{ s: 200 }]);
    expect(await rows(CHILD, 'select 1 from family.playback')).toHaveLength(0);
    await denied(as(CHILD, (tx) => tx.query(`insert into family.playback (user_id, post_id) values ($1, $2)`, [ADULT, p.id])));
    await denied(as(STRANGER, (tx) => tx.query('insert into family.playback (post_id) values ($1)', [p.id])));
  });

  it('can be saved the way the app does it (an upsert)', async () => {
    const [p] = await rows(ADULT, `select id from family.posts where kind = 'podcast_episode' and author_id is null limit 1`);
    const upsert = (pos) => as(CHILD, (tx) => tx.query(`
      insert into family.playback (post_id, position_seconds, duration_seconds, finished, updated_at) values ($1, $2, 3600, false, now())
      on conflict (user_id, post_id) do update set post_id = excluded.post_id, position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds, finished = excluded.finished, updated_at = excluded.updated_at`, [p.id, pos]));
    await upsert(10);
    await upsert(99);
    expect(await rows(CHILD, 'select position_seconds::int as s from family.playback')).toEqual([{ s: 99 }]);
  });
});

describe('Family Feed import', () => {
  it('turns follows into sources and likes into hearts, dropping dislikes, and can be re-run', async () => {
    await db.exec(`
      insert into family.ff_follows (kind, feed_url, title, email) values
        ('podcast', 'https://ff.example/show.rss', 'Old Show', 'adult@example.com'),
        ('podcast', 'https://ff.example/show.rss', 'Old Show', 'admin@example.com');
      insert into family.ff_likes (email, kind, item_url, title, feed_url, liked) values
        ('adult@example.com', 'podcast', 'https://ff.example/ep1', 'Ep 1', 'https://ff.example/show.rss', true),
        ('admin@example.com', 'podcast', 'https://ff.example/ep1', 'Ep 1', 'https://ff.example/show.rss', true),
        ('child@example.com', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'A video', null, true),
        ('adult@example.com', 'link', 'https://news.example/boring', 'Meh', null, false);
    `);
    await denied(as(ADULT, (tx) => tx.query('select * from family.import_family_feed()')));
    const [r] = await rows(ADMIN, 'select * from family.import_family_feed()');
    expect(r).toEqual({ sources_added: 1, posts_added: 2, hearts_added: 3 });
    const [again] = await rows(ADMIN, 'select * from family.import_family_feed()');
    expect(again).toEqual({ sources_added: 0, posts_added: 0, hearts_added: 0 });

    const [video] = await rows(ADULT, `select kind, payload from family.posts where payload ->> 'url' like '%youtube%'`);
    expect(video.kind).toBe('video');
    expect(video.payload.video_id).toBe('dQw4w9WgXcQ');
    expect(await rows(ADULT, `select 1 from family.posts where payload ->> 'url' = 'https://news.example/boring'`)).toHaveLength(0);
    await denied(rows(ADULT, 'select * from family.ff_likes')); // staging is not visible to members
  });
});
