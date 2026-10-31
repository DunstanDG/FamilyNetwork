// Runs the real migration against an in-process Postgres (PGlite) with a stub of Supabase's `auth`
// schema, then checks the row-level security rules by impersonating different people.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const ADULT = '00000000-0000-4000-8000-000000000002';
const CHILD = '00000000-0000-4000-8000-000000000003';
const STRANGER = '00000000-0000-4000-8000-000000000004';

let db;

async function as(uid, fn, role = 'authenticated') {
  return db.transaction(async (tx) => {
    if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}
const rows = async (uid, sql, params = []) => (await as(uid, (tx) => tx.query(sql, params))).rows;
const denied = (promise) => expect(promise).rejects.toThrow();

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  await db.exec(readFileSync(new URL('../../supabase/migrations/0001_family_network.sql', import.meta.url), 'utf8'));
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ADMIN}', 'admin@example.com', '{"avatar_url":"https://example.com/a.png"}'),
      ('${ADULT}', 'adult@example.com', '{}'),
      ('${CHILD}', 'child@example.com', '{}'),
      ('${STRANGER}', 'stranger@example.com', '{"avatar_url":"https://example.com/s.png"}');
    insert into family.households (id, name) values ('10000000-0000-4000-8000-000000000001', 'Home');
    insert into family.profiles (id, display_name, role, household_id) values
      ('${ADMIN}', 'Admin', 'admin', '10000000-0000-4000-8000-000000000001'),
      ('${ADULT}', 'Adult', 'adult', null),
      ('${CHILD}', 'Child', 'child', '10000000-0000-4000-8000-000000000001');
  `);
});

describe('outsiders', () => {
  it('see and write nothing', async () => {
    await as(ADMIN, (tx) => tx.exec(`insert into family.posts (body, kind) values ('hello family', 'update')`));
    expect(await rows(STRANGER, 'select * from family.posts')).toHaveLength(0);
    expect(await rows(STRANGER, 'select * from family.profiles')).toHaveLength(0);
    await denied(as(STRANGER, (tx) => tx.exec(`insert into family.posts (body, kind) values ('let me in', 'update')`)));
  });

  it('anonymous visitors can only ask whether an invite is valid', async () => {
    await denied(as(null, (tx) => tx.query('select * from family.posts'), 'anon'));
    const r = await as(null, (tx) => tx.query(`select family.peek_invite('nope') as ok`), 'anon');
    expect(r.rows[0].ok).toBe(false);
  });
});

describe('posts', () => {
  it('members can read and post, but only as themselves and only updates', async () => {
    await as(CHILD, (tx) => tx.exec(`insert into family.posts (body, kind) values ('child post', 'update')`));
    const mine = await rows(ADULT, `select author_id from family.posts where body = 'child post'`);
    expect(mine[0].author_id).toBe(CHILD);

    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (author_id, body, kind) values ('${ADMIN}', 'forged', 'update')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (body, kind) values ('x', 'event')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (body, kind, pinned) values ('x', 'update', true)`)));
  });

  it('lets the author edit for 15 minutes, then locks the text', async () => {
    await as(ADULT, (tx) => tx.exec(`insert into family.posts (id, body, kind) values ('20000000-0000-4000-8000-000000000001', 'draft', 'update')`));
    await as(ADULT, (tx) => tx.exec(`update family.posts set body = 'edited' where id = '20000000-0000-4000-8000-000000000001'`));
    const [p] = await rows(ADULT, `select body, edited_at from family.posts where id = '20000000-0000-4000-8000-000000000001'`);
    expect(p.body).toBe('edited');
    expect(p.edited_at).not.toBeNull();

    await db.exec(`update family.posts set created_at = now() - interval '16 minutes' where id = '20000000-0000-4000-8000-000000000001'`);
    await denied(as(ADULT, (tx) => tx.exec(`update family.posts set body = 'too late' where id = '20000000-0000-4000-8000-000000000001'`)));
  });

  it('does not let an admin rewrite someone else\'s words, but lets them pin and remove', async () => {
    await denied(as(ADMIN, (tx) => tx.exec(`update family.posts set body = 'censored' where id = '20000000-0000-4000-8000-000000000001'`)));
    await as(ADMIN, (tx) => tx.exec(`update family.posts set pinned = true where id = '20000000-0000-4000-8000-000000000001'`));
    await denied(as(ADULT, (tx) => tx.exec(`update family.posts set pinned = false where id = '20000000-0000-4000-8000-000000000001'`)));
    await as(ADMIN, (tx) => tx.exec(`delete from family.posts where id = '20000000-0000-4000-8000-000000000001'`));
    expect(await rows(ADMIN, `select 1 from family.posts where id = '20000000-0000-4000-8000-000000000001'`)).toHaveLength(0);
  });

  it('stops an admin editing a brand-new post by someone else (author check, not just the clock)', async () => {
    await as(ADULT, (tx) => tx.exec(`insert into family.posts (id, body, kind) values ('20000000-0000-4000-8000-000000000003', 'fresh', 'update')`));
    await denied(as(ADMIN, (tx) => tx.exec(`update family.posts set body = 'rewritten' where id = '20000000-0000-4000-8000-000000000003'`)));
    // A non-author, non-admin is filtered out by RLS: the update silently touches no rows.
    await as(CHILD, (tx) => tx.exec(`update family.posts set body = 'rewritten' where id = '20000000-0000-4000-8000-000000000003'`));
    const [p] = await rows(ADULT, `select body from family.posts where id = '20000000-0000-4000-8000-000000000003'`);
    expect(p.body).toBe('fresh');
  });

  it('only lets the author or an admin delete', async () => {
    await as(ADULT, (tx) => tx.exec(`insert into family.posts (id, body, kind) values ('20000000-0000-4000-8000-000000000002', 'mine', 'update')`));
    await as(CHILD, (tx) => tx.exec(`delete from family.posts where id = '20000000-0000-4000-8000-000000000002'`));
    expect(await rows(ADULT, `select 1 from family.posts where id = '20000000-0000-4000-8000-000000000002'`)).toHaveLength(1);
  });
});

describe('comments', () => {
  const POST = '30000000-0000-4000-8000-000000000001';
  const OTHER_POST = '30000000-0000-4000-8000-000000000002';
  const TOP = '31000000-0000-4000-8000-000000000001';
  const REPLY = '31000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    await db.exec(`
      insert into family.posts (id, author_id, kind, body) values
        ('${POST}', '${ADMIN}', 'update', 'a post'), ('${OTHER_POST}', '${ADMIN}', 'update', 'another');
    `);
  });

  it('nests one level only and keeps replies on the same post', async () => {
    await as(ADULT, (tx) => tx.exec(`insert into family.comments (id, post_id, body) values ('${TOP}', '${POST}', 'first')`));
    await as(CHILD, (tx) => tx.exec(`insert into family.comments (id, post_id, parent_id, body) values ('${REPLY}', '${POST}', '${TOP}', 'reply')`));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.comments (post_id, parent_id, body) values ('${POST}', '${REPLY}', 'too deep')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.comments (post_id, parent_id, body) values ('${OTHER_POST}', '${TOP}', 'wrong post')`)));
  });

  it('keeps comment authorship honest and the edit window to 15 minutes', async () => {
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.comments (author_id, post_id, body) values ('${ADMIN}', '${POST}', 'forged')`)));
    await as(ADULT, (tx) => tx.exec(`update family.comments set body = 'first (edited)' where id = '${TOP}'`));
    await db.exec(`update family.comments set created_at = now() - interval '20 minutes' where id = '${TOP}'`);
    await denied(as(ADULT, (tx) => tx.exec(`update family.comments set body = 'late' where id = '${TOP}'`)));
  });

  it('lets an admin remove a comment', async () => {
    await as(ADMIN, (tx) => tx.exec(`delete from family.comments where id = '${REPLY}'`));
    expect(await rows(ADMIN, `select 1 from family.comments where id = '${REPLY}'`)).toHaveLength(0);
  });
});

describe('reactions', () => {
  const POST = '30000000-0000-4000-8000-000000000001';
  it('allows one of each emoji per person and only your own', async () => {
    await as(ADULT, (tx) => tx.exec(`insert into family.reactions (post_id, emoji) values ('${POST}', 'heart')`));
    await as(ADULT, (tx) => tx.exec(`insert into family.reactions (post_id, emoji) values ('${POST}', 'laugh')`));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.reactions (post_id, emoji) values ('${POST}', 'heart')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.reactions (post_id, emoji) values ('${POST}', 'angry')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.reactions (user_id, post_id, emoji) values ('${ADMIN}', '${POST}', 'wow')`)));
    await as(CHILD, (tx) => tx.exec(`delete from family.reactions where post_id = '${POST}'`));
    expect(await rows(ADMIN, `select 1 from family.reactions where post_id = '${POST}'`)).toHaveLength(2);
  });
  it('needs exactly one target', async () => {
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.reactions (emoji) values ('heart')`)));
  });
});

describe('profiles', () => {
  it('lets people change their name but never their role', async () => {
    await as(ADULT, (tx) => tx.exec(`update family.profiles set display_name = 'Adult Renamed' where id = '${ADULT}'`));
    await denied(as(ADULT, (tx) => tx.exec(`update family.profiles set role = 'admin' where id = '${ADULT}'`)));
    await as(ADULT, (tx) => tx.exec(`update family.profiles set display_name = 'Hijacked' where id = '${CHILD}'`));
    const [c] = await rows(ADMIN, `select display_name from family.profiles where id = '${CHILD}'`);
    expect(c.display_name).toBe('Child');
    await denied(as(ADULT, (tx) => tx.exec(`delete from family.profiles where id = '${CHILD}'`)));
  });
});

describe('invites', () => {
  it('cannot be created by children, and only admins can invite admins', async () => {
    await denied(as(CHILD, (tx) => tx.exec(`insert into family.invites (role) values ('adult')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.invites (role) values ('admin')`)));
    await as(ADULT, (tx) => tx.exec(`insert into family.invites (role, note) values ('child', 'for the grandkids')`));
    await as(ADMIN, (tx) => tx.exec(`insert into family.invites (role) values ('admin')`));
  });

  it('cannot be created pre-used or with a custom expiry', async () => {
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.invites (role, expires_at) values ('adult', now() + interval '1 year')`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.invites (role, used_by) values ('adult', '${ADMIN}')`)));
  });

  it('are visible only to their creator and admins', async () => {
    expect((await rows(ADULT, 'select * from family.invites')).every((i) => i.created_by === ADULT)).toBe(true);
    expect((await rows(CHILD, 'select * from family.invites'))).toHaveLength(0);
    expect((await rows(ADMIN, 'select * from family.invites')).length).toBeGreaterThanOrEqual(2);
  });

  it('can be redeemed once, creating a member with the pre-set role', async () => {
    const [{ code }] = await rows(ADMIN, `insert into family.invites (role, household_id) values ('child', '10000000-0000-4000-8000-000000000001') returning code`);
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect((await as(null, (tx) => tx.query('select family.peek_invite($1) as ok', [code]), 'anon')).rows[0].ok).toBe(true);

    const [prof] = await rows(STRANGER, 'select * from family.redeem_invite($1, $2)', [code, '  Nan  ']);
    expect(prof).toMatchObject({ display_name: 'Nan', role: 'child', avatar_url: 'https://example.com/s.png' });
    expect(prof.household_id).toBe('10000000-0000-4000-8000-000000000001');

    // now a member: can read the timeline
    expect((await rows(STRANGER, 'select 1 from family.posts')).length).toBeGreaterThan(0);
    // the code is spent
    expect((await as(null, (tx) => tx.query('select family.peek_invite($1) as ok', [code]), 'anon')).rows[0].ok).toBe(false);
  });

  it('rejects used, expired, missing and nameless redemptions', async () => {
    const NEWBIE = '00000000-0000-4000-8000-000000000009';
    await db.exec(`insert into auth.users (id, email) values ('${NEWBIE}', 'new@example.com')`);
    const [{ code: expired }] = await rows(ADMIN, `insert into family.invites (role) values ('adult') returning code`);
    await db.exec(`update family.invites set expires_at = now() - interval '1 minute' where code = '${expired}'`);
    await denied(as(NEWBIE, (tx) => tx.query('select * from family.redeem_invite($1, $2)', [expired, 'New'])));
    await denied(as(NEWBIE, (tx) => tx.query(`select * from family.redeem_invite('does-not-exist', 'New')`)));
    const [{ code: fresh }] = await rows(ADMIN, `insert into family.invites (role) values ('adult') returning code`);
    await denied(as(NEWBIE, (tx) => tx.query('select * from family.redeem_invite($1, $2)', [fresh, '   '])));
    await denied(as(null, (tx) => tx.query('select * from family.redeem_invite($1, $2)', [fresh, 'Anon']), 'anon'));
  });

  it('is harmless to redeem again as an existing member', async () => {
    const [{ code }] = await rows(ADMIN, `insert into family.invites (role) values ('admin') returning code`);
    const [prof] = await rows(ADULT, 'select * from family.redeem_invite($1, $2)', [code, 'Adult']);
    expect(prof.role).toBe('adult'); // no promotion by redeeming
  });
});

describe('notifications', () => {
  const POST = '40000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    await db.exec(`insert into family.posts (id, author_id, kind, body, mentions) values ('${POST}', '${ADMIN}', 'update', 'hi @Child', '{${CHILD}}')`);
  });

  it('tells people when they are mentioned or replied to, and nobody else', async () => {
    expect((await rows(CHILD, `select kind from family.notifications where post_id = '${POST}'`)).map((n) => n.kind)).toEqual(['mention']);

    await as(ADULT, (tx) => tx.exec(`insert into family.comments (id, post_id, body) values ('41000000-0000-4000-8000-000000000001', '${POST}', 'nice')`));
    await as(CHILD, (tx) => tx.exec(`insert into family.comments (post_id, parent_id, body, mentions) values ('${POST}', '41000000-0000-4000-8000-000000000001', 'thanks @Adult', '{${ADULT}}')`));
    await as(ADMIN, (tx) => tx.exec(`insert into family.comments (post_id, body) values ('${POST}', 'my own comment')`));

    const forAdmin = await rows(ADMIN, `select kind, actor_id from family.notifications where post_id = '${POST}' order by id`);
    expect(forAdmin.map((n) => n.kind)).toEqual(['reply', 'reply']); // adult's comment + child's reply
    const forAdult = await rows(ADULT, `select kind from family.notifications where post_id = '${POST}'`);
    expect(forAdult.map((n) => n.kind)).toEqual(['mention']); // mentioned in child's reply, not double-notified as parent
    const forChild = await rows(CHILD, `select kind from family.notifications where post_id = '${POST}' order by id`);
    expect(forChild.map((n) => n.kind)).toEqual(['mention']); // own reply never notifies self
  });

  it('are private and can only be marked read', async () => {
    expect((await rows(ADULT, 'select * from family.notifications where user_id <> auth.uid()'))).toHaveLength(0);
    await as(ADULT, (tx) => tx.exec('update family.notifications set read_at = now()'));
    await denied(as(ADULT, (tx) => tx.exec(`update family.notifications set snippet = 'rewritten'`)));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.notifications (user_id, kind, module) values ('${ADMIN}', 'mention', 'update')`)));
  });
});

describe('push subscriptions', () => {
  it('move to whoever registers the device last', async () => {
    await as(ADULT, (tx) => tx.query(`select family.register_push('https://push.example/abc', '{"p256dh":"x","auth":"y"}'::jsonb, 'ua')`));
    await as(CHILD, (tx) => tx.query(`select family.register_push('https://push.example/abc', '{"p256dh":"x","auth":"y"}'::jsonb, 'ua')`));
    expect(await rows(ADULT, 'select 1 from family.push_subscriptions')).toHaveLength(0);
    expect(await rows(CHILD, 'select 1 from family.push_subscriptions')).toHaveLength(1);
  });
});

describe('admin tools', () => {
  it('only work for admins and always leave one admin', async () => {
    await denied(as(ADULT, (tx) => tx.query(`select family.admin_update_member('${CHILD}', 'admin', null)`)));
    await denied(as(ADMIN, (tx) => tx.query(`select family.admin_update_member('${ADMIN}', 'adult', null)`)));
    await denied(as(ADMIN, (tx) => tx.query(`select family.admin_remove_member('${ADMIN}')`)));
    await as(ADMIN, (tx) => tx.query(`select family.admin_update_member('${ADULT}', 'admin', null)`));
    await as(ADMIN, (tx) => tx.query(`select family.admin_update_member('${ADULT}', 'adult', null)`));
  });

  it('removes a member and what they posted, leaving everyone else\'s content', async () => {
    const before = await rows(ADMIN, `select count(*)::int as n from family.posts where author_id = '${CHILD}'`);
    expect(before[0].n).toBeGreaterThan(0);
    await as(ADMIN, (tx) => tx.query(`select family.admin_remove_member('${CHILD}')`));
    expect((await rows(ADMIN, `select count(*)::int as n from family.posts where author_id = '${CHILD}'`))[0].n).toBe(0);
    expect((await rows(ADMIN, `select count(*)::int as n from family.posts`))[0].n).toBeGreaterThan(0);
    expect((await db.query(`select 1 from auth.users where id = '${CHILD}'`)).rows).toHaveLength(1); // sign-in account untouched
  });
});
