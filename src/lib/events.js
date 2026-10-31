// Calendar voting in the app: the same scoring the database uses (family.best_options), so the grid
// can show the leader live, plus .ics invites and date wording.

export const ANSWERS = [
  { key: 'yes', label: 'Yes', points: 2, icon: '✓' },
  { key: 'if_needed', label: 'If needed', points: 1, icon: '~' },
  { key: 'no', label: 'No', points: 0, icon: '✕' },
];
const POINTS = { yes: 2, if_needed: 1, no: 0 };

// options: [{ id, kind, starts_at, position, votes: [{ user_id, answer, rank }] }]
export function scoreEvent(options = [], organiserId) {
  const slots = options.filter((o) => o.kind === 'slot');
  const places = options.filter((o) => o.kind === 'place');
  const n = places.length;
  const slotScores = slots.map((o) => {
    const votes = o.votes || [];
    const mine = votes.find((v) => v.user_id === organiserId);
    return {
      id: o.id,
      score: votes.reduce((s, v) => s + (POINTS[v.answer] ?? 0), 0),
      counts: { yes: votes.filter((v) => v.answer === 'yes').length, if_needed: votes.filter((v) => v.answer === 'if_needed').length, no: votes.filter((v) => v.answer === 'no').length },
      organiser: mine ? POINTS[mine.answer] ?? 0 : null,
      starts_at: o.starts_at, position: o.position,
    };
  });
  const placeScores = places.map((o) => {
    const votes = o.votes || [];
    const mine = votes.find((v) => v.user_id === organiserId);
    return { id: o.id, score: votes.reduce((s, v) => s + Math.max(0, n - v.rank + 1), 0), organiser: mine ? mine.rank : null, position: o.position };
  });
  const bestSlot = [...slotScores].sort((a, b) => b.score - a.score
    || (b.organiser ?? -1) - (a.organiser ?? -1)
    || (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0)
    || a.position - b.position)[0]?.id ?? null;
  const bestPlace = [...placeScores].sort((a, b) => b.score - a.score
    || (a.organiser ?? 99) - (b.organiser ?? 99)
    || a.position - b.position)[0]?.id ?? null;
  const max = Math.max(1, ...slotScores.map((s) => s.score));
  const maxPlace = Math.max(1, ...placeScores.map((s) => s.score));
  return { slots: slotScores, places: placeScores, bestSlot, bestPlace, max, maxPlace };
}

export function voters(options = []) {
  return [...new Set(options.flatMap((o) => (o.votes || []).map((v) => v.user_id)))];
}

const TZ = 'Europe/London';
export function when(iso, { withDay = true } = {}) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: withDay ? 'short' : undefined, day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

export function slotLabel(o) {
  if (!o) return '';
  const end = o.ends_at ? new Date(o.ends_at).toLocaleTimeString('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : null;
  return end ? `${when(o.starts_at)}–${end}` : when(o.starts_at);
}

// Does a slot overlap any busy time? (Slots with no end are treated as two hours.)
export function isBusy(slot, busy = []) {
  const s = Date.parse(slot.starts_at);
  const e = slot.ends_at ? Date.parse(slot.ends_at) : s + 2 * 3600e3;
  return busy.some((b) => Date.parse(b.starts_at) < e && Date.parse(b.ends_at) > s);
}

// ---- .ics ----------------------------------------------------------------------------------------
const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

// Lines longer than 75 bytes must be folded.
function fold(line) {
  const out = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = 75;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 75) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildIcs({ id, title, starts_at, ends_at, place, place_url, link, description = '', sequence = 0, cancelled = false, now = new Date() }) {
  const end = ends_at || new Date(Date.parse(starts_at) + 2 * 3600e3).toISOString();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Network//EN', 'CALSCALE:GREGORIAN', `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${id}@family-network`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(starts_at)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(title)}`,
    place ? `LOCATION:${icsText(place)}` : null,
    `DESCRIPTION:${icsText([description, place_url, link].filter(Boolean).join('\n'))}`,
    link ? `URL:${link}` : null,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'TRIGGER:-P1D', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// Default voting deadline: three days from now, but always before the first date.
export function defaultDeadline(slots, now = Date.now()) {
  const starts = slots.map((s) => Date.parse(s.starts_at)).filter(Number.isFinite);
  const first = starts.length ? Math.min(...starts) : now + 7 * 864e5;
  const threeDays = now + 3 * 864e5;
  const dayBefore = first - 864e5;
  const pick = Math.max(now + 3600e3, Math.min(threeDays, dayBefore));
  return new Date(Math.min(pick, first - 60e3)).toISOString();
}
