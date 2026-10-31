// The pre-launch review fixes: function permissions, HomeQuest failures and links, and calendar edge cases.
import { describe, it, expect, beforeAll } from 'vitest';
import { ADMIN, ADULT, CHILD, HOME, actor, applyMigration, denied, makeDb, seedPeople } from './helpers.js';

const day = (d, h = 13) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(h, 0, 0, 0); return t.toISOString(); };

describe('function permissions', () => {
  let db;
  beforeAll(async () => {
    db = await makeDb({ upTo: 4 });
    // What Supabase may do on a real project: hand every new function to anon and authenticated.
    await db.exec('grant execute on all functions in schema family to anon, authenticated, service_role');
    await applyMigration(db, '0005_hardening.sql');
  });
  const callable = async (role) => (await db.query(`
    select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'family' and has_function_privilege($1, p.oid, 'execute') order by 1`, [role])).rows.map((r) => r.name);

  it('leaves anonymous visitors only the invite check', async () => {
    expect(await callable('anon')).toEqual(['peek_invite']);
  });

  it('leaves signed-in people only what the app calls', async () => {
    expect(await callable('authenticated')).toEqual([
      'admin_remove_member', 'admin_update_member', 'cancel_event', 'cast_votes', 'confirm_event', 'household_busy',
      'import_family_feed', 'is_admin', 'is_member', 'my_role', 'peek_invite', 'propose_event', 'publish_album',
      'redeem_invite', 'register_push', 'rsvp',
    ]);
  });

  it('keeps the gateway and job functions for the service key', async () => {
    expect(await callable('service_role')).toEqual([
      'add_feed_item', 'close_due_events', 'is_member', 'photo_upload_allowed', 'record_photo', 'send_event_reminders',
    ]);
  });
});

describe('calendar and HomeQuest after hardening', () => {
  let db; let as; let rows; let service;
  async function propose(uid, opts = {}) {
    const places = opts.places || [{ name: "Nan's" }, { name: 'The Swan' }];
    const [{ id }] = await rows(uid, 'select family.propose_event(null, $1, $2, $3, $4::jsonb, $5::jsonb) as id',
      ['Lunch', '', opts.deadline || day(5), JSON.stringify((opts.slots || [day(10), day(11)]).map((s) => ({ starts_at: s }))), JSON.stringify(places)]);
    const o = await rows(uid, 'select id, kind from family.event_options where event_id = $1 order by kind desc, position', [id]);
    return { id, slots: o.filter((x) => x.kind === 'slot').map((x) => x.id), places: o.filter((x) => x.kind === 'place').map((x) => x.id) };
  }
  const status = async (id) => (await service('select status, nudged_at, homequest_event_id from family.events where post_id = $1', [id]))[0];

  beforeAll(async () => {
    db = await makeDb();
    await seedPeople(db);
    ({ as, rows, service } = actor(db));
    await db.exec(`insert into family.households (name) values ('Other')`);
    await db.exec(`update family.households set homequest_linked = true, homequest_household_id = 'hq-1' where id = '${HOME}'`);
  });

  it('allows only one household to be linked to HomeQuest', async () => {
    await denied(db.exec(`update family.households set homequest_linked = true where name = 'Other'`));
  });

  it('keeps internal steps out of reach of members', async () => {
    const e = await propose(ADULT);
    await denied(as(CHILD, (tx) => tx.query('select family.confirm_choice($1, $2, $3, null)', [e.id, e.slots[0], e.places[0]])));
    await denied(as(CHILD, (tx) => tx.query('select family.homequest_sync($1)', [e.id])));
  });

  it('refuses a place rank higher than the number of places', async () => {
    const e = await propose(ADULT);
    await denied(as(CHILD, (tx) => tx.query('select family.cast_votes($1, $2::jsonb)', [e.id, JSON.stringify([{ option_id: e.places[0], rank: 3 }])])));
    await denied(as(CHILD, (tx) => tx.query('select family.cast_votes($1, $2::jsonb)', [e.id, JSON.stringify([{ option_id: e.places[0], rank: 0 }])])));
  });

  it('hands an event nobody voted on back to its organiser, once, instead of confirming it', async () => {
    const e = await propose(ADULT);
    await service(`select family.close_due_events(now() + interval '6 days')`);
    await service(`select family.close_due_events(now() + interval '7 days')`);
    expect((await status(e.id)).status).toBe('voting');
    expect((await status(e.id)).nudged_at).not.toBeNull();
    const told = await service(`select user_id, snippet from family.notifications where post_id = $1 and snippet like 'Nobody voted%'`, [e.id]);
    expect(told).toEqual([{ user_id: ADULT, snippet: 'Nobody voted on Lunch. Pick a date or cancel it.' }]);
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[1], e.places[0]]));
    expect((await status(e.id)).status).toBe('confirmed');
  });

  it('logs and skips a HomeQuest failure instead of stopping the calendar', async () => {
    await db.exec(`create or replace function family.homequest_upsert_event(p_existing text, p_event jsonb) returns text
      language plpgsql security definer set search_path = '' as $$ begin raise exception 'HomeQuest is down'; end $$`);
    const e = await propose(ADULT);
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]]));
    await as(ADMIN, (tx) => tx.query(`select family.rsvp($1, 'going', true)`, [e.id]));
    expect((await status(e.id)).status).toBe('confirmed');
    const log = await service('select action, error from family.homequest_outbox where event_id = $1', [e.id]);
    expect(log).toEqual([{ action: 'upsert', error: 'HomeQuest is down' }]);
    expect(await rows(ADMIN, 'select answer from family.event_rsvps where event_id = $1', [e.id])).toEqual([{ answer: 'going' }]);
  });

  it('tells the adapter which HomeQuest household to use', async () => {
    await db.exec(`create or replace function family.homequest_upsert_event(p_existing text, p_event jsonb) returns text
      language plpgsql security definer set search_path = '' as $$ begin
        insert into family.homequest_outbox (action, event_id, payload) values ('upsert', (p_event ->> 'event_id')::uuid, p_event);
        return 'hq-event-1'; end $$`);
    const e = await propose(ADULT);
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]]));
    await as(ADMIN, (tx) => tx.query(`select family.rsvp($1, 'going', true)`, [e.id]));
    const [sent] = await service('select payload from family.homequest_outbox where event_id = $1', [e.id]);
    expect(sent.payload).toMatchObject({ household_id: HOME, homequest_household_id: 'hq-1', attendees: [{ id: ADMIN, name: 'Admin' }] });
    expect((await status(e.id)).homequest_event_id).toBe('hq-event-1');
  });

  it('skips the "tomorrow" reminder when the event was only confirmed the day before', async () => {
    const e = await propose(ADULT, { slots: [day(1, 15), day(2, 15)], deadline: day(0, 23) });
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]]));
    // Pretend it was confirmed at 11am today, and the reminder job runs at noon.
    const t = new Date(); t.setUTCHours(11, 0, 0, 0);
    await db.query('update family.events set confirmed_at = $2 where post_id = $1', [e.id, t.toISOString()]);
    t.setUTCHours(12, 0, 0, 0);
    await service('select family.send_event_reminders($1)', [t.toISOString()]);
    expect(await service(`select 1 from family.notifications where post_id = $1 and snippet like 'Tomorrow:%'`, [e.id])).toHaveLength(0);
    expect((await service('select reminded_for from family.events where post_id = $1', [e.id]))[0].reminded_for).not.toBeNull();
  });
});
