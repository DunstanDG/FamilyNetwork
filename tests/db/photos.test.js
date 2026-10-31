// Phase 3: albums, the gateway's upload rules, photo comments, deletion queue.
import { describe, it, expect, beforeAll } from 'vitest';
import { ADMIN, ADULT, CHILD, STRANGER, actor, denied, makeDb, seedPeople } from './helpers.js';

const ALBUM = '50000000-0000-4000-8000-000000000001';
const UPDATE = '50000000-0000-4000-8000-000000000002';
let db; let as; let rows; let service;

beforeAll(async () => {
  db = await makeDb();
  await seedPeople(db);
  ({ as, rows, service } = actor(db));
  await as(ADULT, (tx) => tx.query(`insert into family.posts (id, kind, payload) values ($1, 'photo_album', '{"title":"Beach day"}')`, [ALBUM]));
  await as(ADULT, (tx) => tx.query(`insert into family.posts (id, kind, body) values ($1, 'update', 'one photo')`, [UPDATE]));
});

const record = (post, user, immich, pos = 0) =>
  service('select * from family.record_photo($1, $2, $3, 800, 600, null, $4)', [post, user, immich, pos]);

describe('uploading', () => {
  it('lets the author add any number of photos to their album', async () => {
    expect((await service('select family.photo_upload_allowed($1, $2) as ok', [ALBUM, ADULT]))[0].ok).toBe(true);
    await record(ALBUM, ADULT, 'imm-1', 0);
    await record(ALBUM, ADULT, 'imm-2', 1);
    expect(await rows(CHILD, 'select immich_asset_id from family.photo_assets where post_id = $1 order by position', [ALBUM]))
      .toEqual([{ immich_asset_id: 'imm-1' }, { immich_asset_id: 'imm-2' }]);
  });

  it('refuses someone else’s post, and a second photo on an update', async () => {
    expect((await service('select family.photo_upload_allowed($1, $2) as ok', [ALBUM, CHILD]))[0].ok).toBe(false);
    await denied(record(ALBUM, CHILD, 'imm-x'));
    await record(UPDATE, ADULT, 'imm-3');
    await denied(record(UPDATE, ADULT, 'imm-4'));
    await denied(record(ALBUM, STRANGER, 'imm-5'));
  });

  it('is only possible through the gateway, never directly', async () => {
    await denied(as(ADULT, (tx) => tx.query(`insert into family.photo_assets (post_id, immich_asset_id) values ($1, 'sneaky')`, [ALBUM])));
    await denied(as(ADULT, (tx) => tx.query(`select family.record_photo($1, $2, 'sneaky', 1, 1, null, 0)`, [ALBUM, ADULT])));
    expect(await rows(STRANGER, 'select * from family.photo_assets')).toHaveLength(0);
  });
});

describe('publishing an album', () => {
  it('notifies everyone else once, and only the author can do it', async () => {
    await denied(as(CHILD, (tx) => tx.query('select family.publish_album($1)', [ALBUM])));
    await as(ADULT, (tx) => tx.query('select family.publish_album($1)', [ALBUM]));
    await as(ADULT, (tx) => tx.query('select family.publish_album($1)', [ALBUM]));
    const n = await service(`select user_id, kind, snippet from family.notifications where post_id = $1 order by user_id`, [ALBUM]);
    expect(n).toEqual([
      { user_id: ADMIN, kind: 'album', snippet: 'Beach day' },
      { user_id: CHILD, kind: 'album', snippet: 'Beach day' },
    ]);
  });
});

describe('comments on a single photo', () => {
  it('must point at a photo in the same post, and replies inherit the photo', async () => {
    const [{ id: photo }] = await rows(ADULT, `select id from family.photo_assets where immich_asset_id = 'imm-1'`);
    const [{ id: other }] = await rows(ADULT, `select id from family.photo_assets where immich_asset_id = 'imm-3'`);
    const [{ id: top }] = await as(CHILD, (tx) => tx.query(`insert into family.comments (post_id, body, photo_asset_id) values ($1, 'lovely', $2) returning id`, [ALBUM, photo])).then((r) => r.rows);
    await denied(as(CHILD, (tx) => tx.query(`insert into family.comments (post_id, body, photo_asset_id) values ($1, 'wrong', $2)`, [ALBUM, other])));
    await as(ADMIN, (tx) => tx.query(`insert into family.comments (post_id, parent_id, body) values ($1, $2, 'agreed')`, [ALBUM, top]));
    const [reply] = await rows(ADMIN, `select photo_asset_id from family.comments where parent_id = $1`, [top]);
    expect(reply.photo_asset_id).toBe(photo);
  });
});

describe('removing photos', () => {
  it('can be done by the uploader or an admin, and queues the Immich copy for the bin', async () => {
    await as(CHILD, (tx) => tx.exec(`delete from family.photo_assets where immich_asset_id = 'imm-2'`));
    expect(await rows(ADULT, `select 1 from family.photo_assets where immich_asset_id = 'imm-2'`)).toHaveLength(1);
    await as(ADULT, (tx) => tx.exec(`delete from family.photo_assets where immich_asset_id = 'imm-2'`));
    expect(await service('select immich_asset_id from family.photo_deletions')).toEqual([{ immich_asset_id: 'imm-2' }]);
  });

  it('keeps an Immich asset that another post still uses', async () => {
    await as(ADULT, (tx) => tx.query(`insert into family.posts (id, kind) values ('50000000-0000-4000-8000-000000000003', 'photo_album')`));
    await record('50000000-0000-4000-8000-000000000003', ADULT, 'imm-1');
    await as(ADMIN, (tx) => tx.exec(`delete from family.posts where id = '50000000-0000-4000-8000-000000000003'`));
    expect((await service(`select 1 from family.photo_deletions where immich_asset_id = 'imm-1'`))).toHaveLength(0);
  });

  it('deleting an album removes its photos, their comments, and queues them', async () => {
    await as(ADULT, (tx) => tx.query('delete from family.posts where id = $1', [ALBUM]));
    expect(await service('select 1 from family.photo_assets where post_id = $1', [ALBUM])).toHaveLength(0);
    expect((await service(`select immich_asset_id from family.photo_deletions order by 1`)).map((r) => r.immich_asset_id)).toEqual(['imm-1', 'imm-2']);
  });

  it('keeps the deletion queue away from members', async () => {
    await denied(rows(ADMIN, 'select * from family.photo_deletions'));
  });
});
