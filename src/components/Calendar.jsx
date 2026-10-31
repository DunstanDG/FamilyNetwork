import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { appUrl } from '../supabase.js';
import { cancelEvent, castVotes, confirmEvent, fetchUpcoming, householdBusy, proposeEvent, rsvp } from '../data.js';
import { ANSWERS, buildIcs, defaultDeadline, isBusy, scoreEvent, slotLabel, voters, when } from '../lib/events.js';
import { normaliseLink } from '../lib/timeline.js';
import { uuid } from '../lib/uuid.js';
import { notifyChanged, openPost, useOnChanged } from '../hooks.js';
import { Message, PersonAvatar, Sheet } from './ui.jsx';

const one = (x) => (Array.isArray(x) ? x[0] : x);
const RSVP = [
  { key: 'going', label: 'Going', icon: '👍' },
  { key: 'maybe', label: 'Maybe', icon: '🤔' },
  { key: 'not_going', label: 'Can’t make it', icon: '🙁' },
];

// <input type="datetime-local"> works in the device's own time; convert both ways.
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

function useBusy(slots) {
  const [busy, setBusy] = useState([]);
  const key = slots.map((s) => s.starts_at).filter(Boolean).sort().join('|');
  useEffect(() => {
    const starts = key ? key.split('|').map((s) => Date.parse(s)) : [];
    if (!starts.length) { setBusy([]); return; }
    const from = new Date(Math.min(...starts) - 864e5).toISOString();
    const to = new Date(Math.max(...starts) + 2 * 864e5).toISOString();
    householdBusy(from, to).then(({ data }) => setBusy(data || []), () => setBusy([]));
  }, [key]);
  return busy;
}

// ---- proposing -----------------------------------------------------------------------------------
export function ProposeEvent({ onClose }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [slots, setSlots] = useState([{ start: '', end: '' }, { start: '', end: '' }]);
  const [places, setPlaces] = useState([{ name: '', url: '' }]);
  const [deadline, setDeadline] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusyState] = useState(false);

  const cleanSlots = slots.filter((s) => s.start).map((s) => ({ starts_at: fromLocalInput(s.start), ends_at: fromLocalInput(s.end) }));
  const homeBusy = useBusy(cleanSlots);
  const suggested = defaultDeadline(cleanSlots);

  const setSlot = (i, patch) => setSlots((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setPlace = (i, patch) => setPlaces((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function submit(e) {
    e.preventDefault();
    setNote('');
    const cleanPlaces = places.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), url: normaliseLink(p.url) || undefined }));
    if (!title.trim()) return setNote('Give it a name, like “Sunday lunch”.');
    if (cleanSlots.length < 2) return setNote('Offer at least two dates so people can choose.');
    if (cleanSlots.some((s) => s.ends_at && s.ends_at <= s.starts_at)) return setNote('Each finish time must be after its start.');
    if (!cleanPlaces.length) return setNote('Add at least one place.');
    setBusyState(true);
    const { error } = await proposeEvent({
      id: uuid(), title: title.trim(), body: body.trim(), deadline: fromLocalInput(deadline) || suggested,
      slots: cleanSlots.map((s) => (s.ends_at ? s : { starts_at: s.starts_at })), places: cleanPlaces,
    });
    setBusyState(false);
    if (error) return setNote(error.message);
    notifyChanged();
    onClose();
    return undefined;
  }

  return (
    <Sheet title="Plan something" onClose={onClose}>
      <form onSubmit={submit} className="propose">
        <label className="label" htmlFor="ev-title">What is it?</label>
        <input id="ev-title" className="field" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Sunday lunch" />
        <label className="label" htmlFor="ev-body">Anything else to say? (optional)</label>
        <textarea id="ev-body" rows={2} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />

        <h3>When could it be? <span className="hint">(2 to 6 choices)</span></h3>
        {slots.map((s, i) => {
          const clash = s.start && isBusy({ starts_at: fromLocalInput(s.start), ends_at: fromLocalInput(s.end) }, homeBusy);
          return (
            <div key={i} className="slot-edit">
              <label>
                <span className="label">Choice {i + 1} starts</span>
                <input className="field" type="datetime-local" value={s.start} onChange={(e) => setSlot(i, { start: e.target.value })} />
              </label>
              <label>
                <span className="label">Finishes (optional)</span>
                <input className="field" type="datetime-local" value={s.end} min={s.start} onChange={(e) => setSlot(i, { end: e.target.value })} />
              </label>
              {clash && <span className="busy-chip">🏠 Busy at home</span>}
              {slots.length > 2 && <button type="button" className="linkish danger" onClick={() => setSlots((l) => l.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          );
        })}
        {slots.length < 6 && <button type="button" className="mini" onClick={() => setSlots((l) => [...l, { start: '', end: '' }])}>＋ Another date</button>}

        <h3>Where? <span className="hint">(1 to 4 choices)</span></h3>
        {places.map((p, i) => (
          <div key={i} className="place-edit">
            <input className="field" maxLength={120} value={p.name} onChange={(e) => setPlace(i, { name: e.target.value })} placeholder={i === 0 ? 'For example: Nan’s house' : 'Another place'} aria-label={`Place ${i + 1}`} />
            <input className="field" type="url" inputMode="url" value={p.url} onChange={(e) => setPlace(i, { url: e.target.value })} placeholder="Map or website link (optional)" aria-label={`Link for place ${i + 1}`} />
            {places.length > 1 && <button type="button" className="linkish danger" onClick={() => setPlaces((l) => l.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        {places.length < 4 && <button type="button" className="mini" onClick={() => setPlaces((l) => [...l, { name: '', url: '' }])}>＋ Another place</button>}

        <h3>Voting closes</h3>
        <input className="field" type="datetime-local" value={deadline || toLocalInput(suggested)} onChange={(e) => setDeadline(e.target.value)} aria-label="Voting closes" />
        <p className="hint">Or sooner, once every adult has voted. The most popular date and place win; ties go your way.</p>

        <button className="primary wide" disabled={busy}>{busy ? 'Sending…' : 'Ask the family'}</button>
        <Message tone="error">{note}</Message>
      </form>
    </Sheet>
  );
}

// ---- the event card ------------------------------------------------------------------------------
export function EventBlock({ post }) {
  const ev = one(post.event);
  if (!ev) return null;
  const options = [...(ev.options || [])].sort((a, b) => a.position - b.position);
  if (ev.status === 'cancelled') return <div className="event cancelled"><p className="event-title">{ev.title}</p><p className="msg">This was cancelled.</p></div>;
  return ev.status === 'confirmed'
    ? <Confirmed post={post} ev={ev} options={options} />
    : <Voting post={post} ev={ev} options={options} />;
}

function Voting({ post, ev, options }) {
  const { profile } = useAuth();
  const { byId, members } = useMembers();
  const organiser = post.author_id === profile.id || profile.role === 'admin';
  const slots = options.filter((o) => o.kind === 'slot');
  const places = options.filter((o) => o.kind === 'place');
  const mineFrom = useCallback(() => {
    const d = {};
    options.forEach((o) => { const v = (o.votes || []).find((x) => x.user_id === profile.id); if (v) d[o.id] = v.answer || v.rank; });
    return d;
  }, [options, profile.id]);
  const [draft, setDraft] = useState(mineFrom);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState({ text: '', tone: '' });
  const [picking, setPicking] = useState(false);
  const busy = useBusy(slots);
  useEffect(() => { if (!dirty) setDraft(mineFrom()); }, [mineFrom, dirty]);

  // Score with my unsaved choices in place of my saved ones, so I can see the effect as I tap.
  const live = useMemo(() => scoreEvent(options.map((o) => {
    const others = (o.votes || []).filter((v) => v.user_id !== profile.id);
    const mine = draft[o.id];
    if (mine === undefined) return { ...o, votes: others };
    return { ...o, votes: [...others, o.kind === 'slot' ? { user_id: profile.id, answer: mine } : { user_id: profile.id, rank: mine }] };
  }), post.author_id), [options, draft, profile.id, post.author_id]);

  const who = voters(options);
  const adults = members.filter((m) => m.role !== 'child').length;
  const open = new Date(ev.deadline) > new Date();

  const answer = (id, key) => { setDraft((d) => ({ ...d, [id]: key })); setDirty(true); };
  const rankTap = (id) => {
    setDirty(true);
    setDraft((d) => {
      const next = { ...d };
      if (next[id]) {
        const gone = next[id];
        delete next[id];
        places.forEach((p) => { if (next[p.id] > gone) next[p.id] -= 1; });
      } else {
        next[id] = places.filter((p) => next[p.id]).length + 1;
      }
      return next;
    });
  };

  async function save() {
    setNote({ text: '', tone: '' });
    const votes = options.filter((o) => draft[o.id] !== undefined).map((o) => (o.kind === 'slot' ? { option_id: o.id, answer: draft[o.id] } : { option_id: o.id, rank: draft[o.id] }));
    const { data, error } = await castVotes(ev.post_id, votes);
    if (error) return setNote({ text: error.message, tone: 'error' });
    setDirty(false);
    setNote({ text: data === 'confirmed' ? 'Everyone has voted, so it’s decided!' : 'Thanks, your votes are in.', tone: 'ok' });
    notifyChanged();
    return undefined;
  }

  return (
    <div className="event">
      <p className="event-title">{ev.title}</p>
      <p className="when">
        {open ? `Voting closes ${when(ev.deadline)}` : who.length ? 'Voting has closed; deciding…' : 'Voting has closed and nobody voted. The organiser will pick a date or cancel.'}
        {' · '}{who.length} of {adults} adults have voted
      </p>
      {who.length > 0 && <div className="voted-by">{who.map((id) => <PersonAvatar key={id} person={byId.get(id)} size={28} />)}</div>}

      <h4>When?</h4>
      <ul className="plain vote-list">
        {slots.map((o) => {
          const s = live.slots.find((x) => x.id === o.id);
          return (
            <li key={o.id} className={`vote-row ${live.bestSlot === o.id ? 'best' : ''}`}>
              <div className="vote-head">
                <strong>{slotLabel(o)}</strong>
                {live.bestSlot === o.id && s.score > 0 && <span className="badge">★ Leading</span>}
                {isBusy(o, busy) && <span className="busy-chip">🏠 Busy at home</span>}
              </div>
              <div className="score-bar" aria-hidden="true"><span style={{ width: `${(s.score / live.max) * 100}%` }} /></div>
              <p className="hint">{s.counts.yes} yes · {s.counts.if_needed} if needed · {s.counts.no} no</p>
              {open && (
                <div className="answer-row" role="group" aria-label={`Can you do ${slotLabel(o)}?`}>
                  {ANSWERS.map((a) => (
                    <button key={a.key} type="button" className={`answer ${a.key} ${draft[o.id] === a.key ? 'on' : ''}`} aria-pressed={draft[o.id] === a.key} onClick={() => answer(o.id, a.key)}>
                      {a.icon} {a.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <h4>Where? {open && places.length > 1 && <span className="hint">Tap your favourite first</span>}</h4>
      <ul className="plain vote-list">
        {places.map((o) => {
          const s = live.places.find((x) => x.id === o.id);
          const rank = draft[o.id];
          return (
            <li key={o.id} className={`vote-row place ${live.bestPlace === o.id ? 'best' : ''}`}>
              <button type="button" className={`rank-btn ${rank ? 'on' : ''}`} onClick={() => open && places.length > 1 && rankTap(o.id)} disabled={!open || places.length === 1} aria-label={rank ? `${o.place_name}, your choice ${rank}. Tap to clear.` : `Choose ${o.place_name}`}>
                {rank ? <span className="rank-num">{rank}</span> : <span className="rank-num empty" />}
                <span className="grow">
                  <strong>{o.place_name}</strong>
                  {places.length > 1 && <span className="hint"> · {s.score} pts</span>}
                </span>
                {live.bestPlace === o.id && places.length > 1 && s.score > 0 && <span className="badge">★</span>}
              </button>
              {o.place_url && normaliseLink(o.place_url) && <a className="linkish" href={normaliseLink(o.place_url)} target="_blank" rel="noopener noreferrer">Map / website</a>}
            </li>
          );
        })}
      </ul>

      {open && <button className="primary wide" onClick={save} disabled={!dirty}>Save my votes</button>}
      <Message tone={note.tone}>{note.text}</Message>

      {organiser && (
        <div className="organiser">
          {picking
            ? <ConfirmPicker ev={ev} options={options} best={live} onDone={() => setPicking(false)} />
            : (
              <div className="row wrap">
                <button className="mini" onClick={() => setPicking(true)}>✅ Decide now</button>
                <CancelButton ev={ev} />
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function ConfirmPicker({ ev, options, best, onDone }) {
  const slots = options.filter((o) => o.kind === 'slot');
  const places = options.filter((o) => o.kind === 'place');
  const [slot, setSlot] = useState(ev.chosen_option_id || best?.bestSlot || slots[0]?.id);
  const [place, setPlace] = useState(ev.chosen_place_id || best?.bestPlace || places[0]?.id);
  const [note, setNote] = useState('');
  async function go() {
    const { error } = await confirmEvent(ev.post_id, slot, place);
    if (error) return setNote(error.message);
    notifyChanged(); onDone();
    return undefined;
  }
  return (
    <div className="confirm-pick">
      <label className="label" htmlFor={`cs-${ev.post_id}`}>Date</label>
      <select id={`cs-${ev.post_id}`} className="field" value={slot} onChange={(e) => setSlot(e.target.value)}>
        {slots.map((o) => <option key={o.id} value={o.id}>{slotLabel(o)}{best?.bestSlot === o.id ? ' (most popular)' : ''}</option>)}
      </select>
      <label className="label" htmlFor={`cp-${ev.post_id}`}>Place</label>
      <select id={`cp-${ev.post_id}`} className="field" value={place} onChange={(e) => setPlace(e.target.value)}>
        {places.map((o) => <option key={o.id} value={o.id}>{o.place_name}{best?.bestPlace === o.id ? ' (most popular)' : ''}</option>)}
      </select>
      <div className="row wrap">
        <button className="primary" onClick={go}>Confirm and tell everyone</button>
        <button className="mini" onClick={onDone}>Not yet</button>
      </div>
      <Message tone="error">{note}</Message>
    </div>
  );
}

function CancelButton({ ev }) {
  const [note, setNote] = useState('');
  async function go() {
    if (!window.confirm(`Cancel “${ev.title}” for everyone?`)) return;
    const { error } = await cancelEvent(ev.post_id);
    if (error) setNote(error.message); else notifyChanged();
  }
  return <><button className="mini danger" onClick={go}>Cancel event</button><Message tone="error">{note}</Message></>;
}

function Confirmed({ post, ev, options }) {
  const { profile } = useAuth();
  const { byId, members, households } = useMembers();
  const slot = options.find((o) => o.id === ev.chosen_option_id);
  const place = options.find((o) => o.id === ev.chosen_place_id);
  const rsvps = ev.rsvps || [];
  const mine = rsvps.find((r) => r.user_id === profile.id);
  const linked = households.find((h) => h.id === profile.household_id)?.homequest_linked;
  const kids = profile.role !== 'child' && profile.household_id ? members.filter((m) => m.role === 'child' && m.household_id === profile.household_id) : [];
  const organiser = post.author_id === profile.id || profile.role === 'admin';
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState({ text: '', tone: '' });
  const past = slot && new Date(slot.starts_at) < new Date();

  async function answer(forUser, key, add) {
    setNote({ text: '', tone: '' });
    const current = rsvps.find((r) => r.user_id === (forUser || profile.id));
    const { error } = await rsvp({ eventId: ev.post_id, answer: key, addToHomequest: add ?? (key !== 'not_going' && Boolean(current?.add_to_homequest)), forUser });
    if (error) return setNote({ text: error.message, tone: 'error' });
    notifyChanged();
    return undefined;
  }

  function ics() {
    const text = buildIcs({
      id: ev.post_id, title: ev.title, starts_at: slot.starts_at, ends_at: slot.ends_at, place: place?.place_name,
      place_url: place?.place_url, link: `${appUrl()}?post=${ev.post_id}`, description: post.body || '',
      sequence: Math.floor(new Date(ev.confirmed_at || Date.now()).getTime() / 1000) % 100000,
    });
    const file = new File([text], `${ev.title.replace(/[^\w ]+/g, '').trim() || 'event'}.ics`, { type: 'text/calendar' });
    if (navigator.canShare?.({ files: [file] })) { navigator.share({ files: [file], title: ev.title }).catch(() => {}); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const by = (key) => rsvps.filter((r) => r.answer === key);

  return (
    <div className="event confirmed">
      <p className="event-title">{ev.title}</p>
      <p className="event-when">📅 {slot ? slotLabel(slot) : 'Date to be confirmed'}</p>
      {place && (
        <p className="event-where">📍 {place.place_url && normaliseLink(place.place_url)
          ? <a href={normaliseLink(place.place_url)} target="_blank" rel="noopener noreferrer">{place.place_name}</a>
          : place.place_name}</p>
      )}

      {RSVP.map((r) => by(r.key).length > 0 && (
        <div key={r.key} className="rsvp-group">
          <span className="hint">{r.label}:</span>
          {by(r.key).map((x) => <PersonAvatar key={x.user_id} person={byId.get(x.user_id)} size={28} />)}
        </div>
      ))}

      {!past && (
        <>
          <h4>Are you coming?</h4>
          <div className="answer-row" role="group" aria-label="Are you coming?">
            {RSVP.map((r) => (
              <button key={r.key} className={`answer ${r.key} ${mine?.answer === r.key ? 'on' : ''}`} aria-pressed={mine?.answer === r.key} onClick={() => answer(null, r.key)}>
                {r.icon} {r.label}
              </button>
            ))}
          </div>
          {linked && mine && mine.answer !== 'not_going' && (
            <label className="toggle">
              <input type="checkbox" checked={Boolean(mine.add_to_homequest)} onChange={(e) => answer(null, mine.answer, e.target.checked)} />
              <span>Add to my HomeQuest</span>
            </label>
          )}
          {kids.length > 0 && (
            <div className="kids">
              <h4>For the children</h4>
              {kids.map((k) => {
                const r = rsvps.find((x) => x.user_id === k.id);
                return (
                  <div key={k.id} className="kid-row">
                    <PersonAvatar person={k} size={32} />
                    <strong className="grow">{k.display_name}</strong>
                    <select className="field" value={r?.answer || ''} onChange={(e) => answer(k.id, e.target.value)} aria-label={`Is ${k.display_name} coming?`}>
                      <option value="" disabled>Coming?</option>
                      {RSVP.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </select>
                    {linked && r && r.answer !== 'not_going' && (
                      <label className="toggle small">
                        <input type="checkbox" checked={Boolean(r.add_to_homequest)} onChange={(e) => answer(k.id, r.answer, e.target.checked)} />
                        <span>HomeQuest</span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {slot && <button className="mini wide" onClick={ics}>📅 Add to my calendar</button>}
        </>
      )}
      <Message tone={note.tone}>{note.text}</Message>

      {organiser && !past && (
        <div className="organiser">
          {changing
            ? <ConfirmPicker ev={ev} options={options} best={scoreEvent(options, post.author_id)} onDone={() => setChanging(false)} />
            : <div className="row wrap"><button className="mini" onClick={() => setChanging(true)}>Change date or place</button><CancelButton ev={ev} /></div>}
        </div>
      )}
    </div>
  );
}

// ---- coming up -----------------------------------------------------------------------------------
export function Upcoming({ limit = 3 }) {
  const [list, setList] = useState([]);
  const load = useCallback(async () => {
    const { data } = await fetchUpcoming();
    setList(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  useOnChanged(load);
  if (!list.length) return null;
  return (
    <section className="upcoming card-lite" aria-label="Coming up">
      <h2>Coming up</h2>
      <ul className="plain">
        {list.slice(0, limit).map((e) => (
          <li key={e.post_id}>
            <button className="upcoming-row" onClick={() => openPost(e.post_id)}>
              <span className="up-date">
                <strong>{new Date(e.chosen.starts_at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric' })}</strong>
                <small>{new Date(e.chosen.starts_at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', month: 'short' })}</small>
              </span>
              <span className="grow">
                <strong>{e.title}</strong>
                <small>{when(e.chosen.starts_at)}{e.place?.place_name ? ` · ${e.place.place_name}` : ''}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
