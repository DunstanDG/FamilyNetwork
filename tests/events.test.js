import { describe, it, expect } from 'vitest';
import { buildIcs, defaultDeadline, isBusy, scoreEvent, slotLabel, voters } from '../src/lib/events.js';

const opt = (id, kind, extra = {}, votes = []) => ({ id, kind, position: 0, votes, ...extra });

describe('scoring (same rules as the database)', () => {
  it('scores Yes 2, If needed 1, No 0 and picks the highest', () => {
    const s = scoreEvent([
      opt('a', 'slot', { starts_at: '2026-11-08T13:00:00Z' }, [{ user_id: 'x', answer: 'yes' }, { user_id: 'y', answer: 'no' }]),
      opt('b', 'slot', { starts_at: '2026-11-09T13:00:00Z' }, [{ user_id: 'x', answer: 'if_needed' }, { user_id: 'y', answer: 'yes' }, { user_id: 'z', answer: 'if_needed' }]),
    ], 'org');
    expect(s.slots.map((x) => x.score)).toEqual([2, 4]);
    expect(s.slots[1].counts).toEqual({ yes: 1, if_needed: 2, no: 0 });
    expect(s.bestSlot).toBe('b');
  });
  it('breaks ties toward the organiser, then the earliest date', () => {
    const tie = [
      opt('late', 'slot', { starts_at: '2026-11-09T13:00:00Z' }, [{ user_id: 'org', answer: 'yes' }]),
      opt('early', 'slot', { starts_at: '2026-11-08T13:00:00Z' }, [{ user_id: 'x', answer: 'yes' }]),
    ];
    expect(scoreEvent(tie, 'org').bestSlot).toBe('late');
    expect(scoreEvent(tie, 'nobody').bestSlot).toBe('early');
  });
  it('ranks places by points (n - rank + 1), ties to the organiser’s favourite', () => {
    const places = [
      opt('nan', 'place', { position: 0 }, [{ user_id: 'x', rank: 1 }, { user_id: 'org', rank: 2 }]),
      opt('swan', 'place', { position: 1 }, [{ user_id: 'x', rank: 2 }, { user_id: 'org', rank: 1 }]),
    ];
    const s = scoreEvent(places, 'org');
    expect(s.places.map((p) => p.score)).toEqual([3, 3]);
    expect(s.bestPlace).toBe('swan');
  });
  it('lists who has voted', () => {
    expect(voters([opt('a', 'slot', {}, [{ user_id: 'x' }]), opt('b', 'place', {}, [{ user_id: 'x' }, { user_id: 'y' }])]).sort()).toEqual(['x', 'y']);
  });
});

describe('dates', () => {
  it('words slots in UK time', () => {
    expect(slotLabel({ starts_at: '2026-11-08T13:00:00Z' })).toBe('Sun 8 Nov, 13:00');
    expect(slotLabel({ starts_at: '2026-07-05T12:00:00Z', ends_at: '2026-07-05T15:30:00Z' })).toBe('Sun 5 Jul, 13:00–16:30');
  });
  it('spots clashes with busy times', () => {
    const busy = [{ starts_at: '2026-11-08T12:00:00Z', ends_at: '2026-11-08T13:30:00Z' }];
    expect(isBusy({ starts_at: '2026-11-08T13:00:00Z' }, busy)).toBe(true);
    expect(isBusy({ starts_at: '2026-11-08T14:00:00Z' }, busy)).toBe(false);
  });
  it('picks a deadline before the first date', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    expect(defaultDeadline([{ starts_at: '2026-11-20T13:00:00Z' }], now)).toBe('2026-11-04T10:00:00.000Z');
    expect(defaultDeadline([{ starts_at: '2026-11-02T13:00:00Z' }], now)).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('.ics invites', () => {
  it('builds a valid, folded calendar file with a day-before alarm', () => {
    const ics = buildIcs({
      id: 'abc', title: 'Sunday lunch, all welcome; bring pud', starts_at: '2026-11-08T13:00:00Z', place: "Nan's",
      link: 'https://example.github.io/FamilyNetwork/?post=abc', description: 'x'.repeat(200), now: new Date('2026-11-01T00:00:00Z'),
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261108T130000Z\r\n');
    expect(ics).toContain('DTEND:20261108T150000Z\r\n');
    expect(ics).toContain('SUMMARY:Sunday lunch\\, all welcome\\; bring pud');
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(buildIcs({ id: 'abc', title: 't', starts_at: '2026-11-08T13:00:00Z', cancelled: true })).toContain('STATUS:CANCELLED');
  });
});
