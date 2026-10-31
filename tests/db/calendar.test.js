// Phase 4: proposing, voting, closing, confirming, RSVPs, reminders and the HomeQuest hand-off.
import { describe, it, expect, beforeAll } from 'vitest';
import { ADMIN, ADULT, CHILD, HOME, STRANGER, actor, denied, makeDb, seedPeople } from './helpers.js';

let db; let as; let rows; let service;
const day = (d, h = 13) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(h, 0, 0, 0); return t.toISOString(); };

async function propose(uid, { slots = [day(10), day(11)], places = [{ name: "Nan's" }, { name: 'The Swan', url: 'https://swan.example' }], deadline = day(5), title = 'Sunday lunch' } = {}) {
  const [{ id }] = await rows(uid, 'select family.propose_event(null, $1, $2, $3, $4::jsonb, $5::jsonb) as id',
    [title, 'Who is in?', deadline, JSON.stringify(slots.map((s) => ({ starts_at: s }))), JSON.stringify(places)]);
  const opts = await rows(uid, 'select id, kind, position from family.event_options where event_id = $1 order by kind desc, position', [id]);
  return { id, slots: opts.filter((o) => o.kind === 'slot').map((o) => o.id), places: opts.filter((o) => o.kind === 'place').map((o) => o.id) };
}
const vote = (uid, eventId, votes) => rows(uid, 'select family.cast_votes($1, $2::jsonb) as r', [eventId, JSON.stringify(votes)]).then((r) => r[0].r);
const status = async (id) => (await rows(ADMIN, 'select status, chosen_option_id, chosen_place_id, homequest_event_id from family.events where post_id = $1', [id]))[0];

beforeAll(async () => {
  db = await makeDb();
  await seedPeople(db);
  ({ as, rows, service } = actor(db));
  await db.exec(`update family.households set homequest_linked = true where id = '${HOME}'`);
});

describe('proposing', () => {
  it('needs 2-6 dates, 1-4 places, a future deadline before the first date', async () => {
    await denied(propose(ADULT, { slots: [day(10)] }));
    await denied(propose(ADULT, { places: [] }));
    await denied(propose(ADULT, { slots: [day(-1), day(10)] }));
    await denied(propose(ADULT, { deadline: day(20) }));
    await denied(propose(ADULT, { title: '  ' }));
    await denied(propose(STRANGER));
    await denied(as(ADULT, (tx) => tx.exec(`insert into family.posts (kind) values ('event')`)));
  });

  it('creates an event post and asks everyone else to vote', async () => {
    const e = await propose(ADULT);
    expect(e.slots).toHaveLength(2);
    expect(e.places).toHaveLength(2);
    const [post] = await rows(CHILD, 'select kind, author_id, payload from family.posts where id = $1', [e.id]);
    expect(post).toMatchObject({ kind: 'event', author_id: ADULT, payload: { title: 'Sunday lunch' } });
    const told = await service(`select user_id from family.notifications where post_id = $1 and kind = 'vote' order by user_id`, [e.id]);
    expect(told.map((t) => t.user_id)).toEqual([ADMIN, CHILD]);
  });
});

describe('voting', () => {
  let e;
  beforeAll(async () => { e = await propose(ADULT); });

  it('accepts a full set of votes and replaces them on a second go', async () => {
    expect(await vote(CHILD, e.id, [{ option_id: e.slots[0], answer: 'yes' }, { option_id: e.places[1], rank: 1 }])).toBe('voting');
    await vote(CHILD, e.id, [{ option_id: e.slots[1], answer: 'if_needed' }]);
    expect(await rows(ADULT, 'select option_id, answer from family.event_votes where user_id = $1', [CHILD])).toEqual([{ option_id: e.slots[1], answer: 'if_needed' }]);
  });

  it('refuses mismatched, duplicate-rank or foreign votes, and direct writes', async () => {
    await denied(vote(CHILD, e.id, [{ option_id: e.slots[0], rank: 1 }]));
    await denied(vote(CHILD, e.id, [{ option_id: e.places[0], answer: 'yes' }]));
    await denied(vote(CHILD, e.id, [{ option_id: e.places[0], rank: 1 }, { option_id: e.places[1], rank: 1 }]));
    const other = await propose(ADMIN);
    await denied(vote(CHILD, e.id, [{ option_id: other.slots[0], answer: 'yes' }]));
    await denied(as(CHILD, (tx) => tx.query(`insert into family.event_votes (option_id, answer) values ($1, 'yes')`, [e.slots[0]])));
  });

  it('closes early and picks the best date and place once every adult has voted', async () => {
    // slot 0: admin yes(2) + adult no(0) = 2; slot 1: admin if_needed(1) + adult yes(2) + child if_needed(1) = 4
    await vote(ADMIN, e.id, [{ option_id: e.slots[0], answer: 'yes' }, { option_id: e.slots[1], answer: 'if_needed' }, { option_id: e.places[0], rank: 1 }, { option_id: e.places[1], rank: 2 }]);
    expect((await status(e.id)).status).toBe('voting');
    const r = await vote(ADULT, e.id, [{ option_id: e.slots[0], answer: 'no' }, { option_id: e.slots[1], answer: 'yes' }, { option_id: e.places[1], rank: 1 }, { option_id: e.places[0], rank: 2 }]);
    expect(r).toBe('confirmed');
    // places: Nan's = admin 2 + adult 1 = 3; Swan = admin 1 + adult 2 = 3 -> tie, organiser (adult) ranked Swan first
    expect(await status(e.id)).toMatchObject({ status: 'confirmed', chosen_option_id: e.slots[1], chosen_place_id: e.places[1] });
    const told = await service(`select user_id, snippet from family.notifications where post_id = $1 and kind = 'event'`, [e.id]);
    expect(told).toHaveLength(3); // nobody acted, so everyone hears
    expect(told[0].snippet).toMatch(/^Sunday lunch: .* at The Swan$/);
    await denied(vote(CHILD, e.id, [{ option_id: e.slots[0], answer: 'yes' }]));
  });
});

describe('deadlines and the organiser', () => {
  it('auto-closes at the deadline, breaking ties toward the organiser, then the earliest date', async () => {
    const e = await propose(ADMIN, { slots: [day(12), day(9), day(14)] });
    await vote(CHILD, e.id, [{ option_id: e.slots[0], answer: 'yes' }, { option_id: e.slots[2], answer: 'yes' }]);
    await vote(ADMIN, e.id, [{ option_id: e.slots[2], answer: 'if_needed' }]);
    // slot 0 = 2, slot 2 = 3: slot 2 wins outright
    expect((await service('select family.close_due_events(now() + interval \'6 days\') as n'))[0].n).toBeGreaterThanOrEqual(1);
    expect((await status(e.id)).chosen_option_id).toBe(e.slots[2]);
    const untouched = await propose(ADMIN);
    expect(await service('select family.close_due_events(now()) as n')).toEqual([{ n: 0 }]);
    expect((await status(untouched.id)).status).toBe('voting');
  });

  it('lets only the organiser (or an admin) confirm, change the date, or cancel', async () => {
    const e = await propose(ADULT);
    await denied(as(CHILD, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]])));
    await denied(as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.places[0], e.places[0]])));
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]]));
    await as(ADMIN, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[1], e.places[0]]));
    expect((await status(e.id)).chosen_option_id).toBe(e.slots[1]);
    await denied(as(CHILD, (tx) => tx.query('select family.cancel_event($1)', [e.id])));
    await as(ADULT, (tx) => tx.query('select family.cancel_event($1)', [e.id]));
    expect((await status(e.id)).status).toBe('cancelled');
    await denied(as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]])));
  });
});

describe('RSVPs and HomeQuest', () => {
  let e;
  beforeAll(async () => {
    e = await propose(ADULT);
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]]));
  });
  const outbox = () => service('select action, homequest_event_id, payload from family.homequest_outbox where event_id = $1 order by id', [e.id]);

  it('adds nothing to HomeQuest by default', async () => {
    await as(ADMIN, (tx) => tx.query(`select family.rsvp($1, 'going')`, [e.id]));
    expect(await outbox()).toHaveLength(0);
    expect((await status(e.id)).homequest_event_id).toBeNull();
  });

  it('only offers HomeQuest to linked households', async () => {
    await denied(as(ADULT, (tx) => tx.query(`select family.rsvp($1, 'going', true)`, [e.id]))); // ADULT has no household
  });

  it('lets a parent answer for a child in their household, but not the other way round', async () => {
    await as(ADMIN, (tx) => tx.query(`select family.rsvp($1, 'going', true, $2)`, [e.id, CHILD]));
    await denied(as(CHILD, (tx) => tx.query(`select family.rsvp($1, 'going', false, $2)`, [e.id, ADMIN])));
    await denied(as(ADULT, (tx) => tx.query(`select family.rsvp($1, 'going', false, $2)`, [e.id, CHILD]))); // different household
    const [r] = await rows(ADULT, 'select answer, add_to_homequest, set_by from family.event_rsvps where user_id = $1', [CHILD]);
    expect(r).toEqual({ answer: 'going', add_to_homequest: true, set_by: ADMIN });
  });

  it('sends the household copy once someone opts in, and keeps it in step', async () => {
    let q = await outbox();
    expect(q).toHaveLength(1);
    expect(q[0].action).toBe('upsert');
    expect(q[0].payload.attendees).toEqual([{ id: CHILD, name: 'Child' }]);
    expect((await status(e.id)).homequest_event_id).toBe(`queued-${e.id}`);

    await as(ADMIN, (tx) => tx.query(`select family.rsvp($1, 'going', true)`, [e.id]));
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[1], e.places[0]]));
    q = await outbox();
    const last = q[q.length - 1];
    expect(last.action).toBe('upsert');
    expect(last.homequest_event_id).toBe(`queued-${e.id}`);
    expect(last.payload.attendees.map((a) => a.name)).toEqual(['Admin', 'Child']);

    await as(ADULT, (tx) => tx.query('select family.cancel_event($1)', [e.id]));
    q = await outbox();
    expect(q[q.length - 1]).toMatchObject({ action: 'delete', homequest_event_id: `queued-${e.id}` });
    expect((await status(e.id)).homequest_event_id).toBeNull();
  });

  it('only works on confirmed events', async () => {
    const v = await propose(ADULT);
    await denied(as(ADMIN, (tx) => tx.query(`select family.rsvp($1, 'going')`, [v.id])));
  });
});

describe('reminders', () => {
  it('fire once, from 9am the day before, to everyone not saying no', async () => {
    const e = await propose(ADULT, { slots: [day(10), day(11)] });
    await as(ADULT, (tx) => tx.query('select family.confirm_event($1, $2, $3)', [e.id, e.slots[0], e.places[0]]));
    await as(CHILD, (tx) => tx.query(`select family.rsvp($1, 'not_going')`, [e.id]));
    const eve = (h) => { const t = new Date(day(9)); t.setUTCHours(h, 30, 0, 0); return t.toISOString(); }; // London = UTC in winter, BST in summer
    expect(await service('select family.send_event_reminders($1) as n', [eve(6)])).toEqual([{ n: 0 }]);
    expect((await service('select family.send_event_reminders($1) as n', [eve(12)]))[0].n).toBeGreaterThanOrEqual(1);
    expect((await service('select family.send_event_reminders($1) as n', [eve(13)]))[0].n).toBe(0);
    const told = await service(`select user_id, snippet from family.notifications where post_id = $1 and snippet like 'Tomorrow:%' order by user_id`, [e.id]);
    expect(told.map((t) => t.user_id)).toEqual([ADMIN, ADULT]);
  });
});

describe('free/busy', () => {
  it('is only for linked households and says nothing by default', async () => {
    expect(await rows(ADMIN, 'select * from family.household_busy(now(), now() + interval \'30 days\')')).toEqual([]);
    expect(await rows(ADULT, 'select * from family.household_busy(now(), now() + interval \'30 days\')')).toEqual([]);
    await denied(rows(ADMIN, 'select * from family.homequest_busy($1, now(), now() + interval \'1 day\')', [HOME]));
  });
});
