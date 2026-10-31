import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { fetchSources, followSource, lookup, unfollowSource } from '../data.js';
import { normaliseLink } from '../lib/timeline.js';
import { safeImage, youtubeChannelRef } from '../lib/links.js';
import { ago } from '../lib/time.js';
import { Message, Sheet } from './ui.jsx';

const WORDS = {
  podcast: {
    title: 'Shows we follow', one: 'show', add: 'Follow a show',
    help: 'New episodes from these shows appear by themselves, gathered into one “New from your shows” card a day.',
    search: 'Search for a show', paste: 'Or paste the show’s RSS feed link',
  },
  youtube: {
    title: 'Channels we follow', one: 'channel', add: 'Follow a channel',
    help: 'New videos from these channels appear by themselves, gathered into one “New from your shows” card a day.',
    paste: 'Paste a link to the channel (for example youtube.com/@name)',
  },
};

function Face({ image, kind }) {
  const src = safeImage(image);
  return src ? <img className="source-face" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="source-face" aria-hidden="true">{kind === 'youtube' ? '▶️' : '🎧'}</span>;
}

export function useSources(kind) {
  const [list, setList] = useState(null);
  const reload = useCallback(async () => {
    const { data } = await fetchSources(kind);
    setList(data || []);
  }, [kind]);
  useEffect(() => { reload(); }, [reload]);
  return { list, reload };
}

// Follow and unfollow podcasts or YouTube channels for the whole family.
export default function SourcesSheet({ kind, onClose }) {
  const w = WORDS[kind];
  const { profile } = useAuth();
  const { byId } = useMembers();
  const { list, reload } = useSources(kind);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [link, setLink] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ text: '', tone: '' });

  const followed = new Set((list || []).map((s) => s.feed_url));

  async function follow(row) {
    setNote({ text: '', tone: '' });
    const { error } = await followSource({ kind, feed_url: row.feed_url, title: row.title || '', image_url: safeImage(row.image), site_url: row.site_url ? normaliseLink(row.site_url) : null });
    if (error) {
      return setNote({ text: error.code === '23505' ? `The family already follows this ${w.one}.` : error.message, tone: 'error' });
    }
    setNote({ text: `Following ${row.title || `this ${w.one}`}. The newest ${kind === 'youtube' ? 'video' : 'episode'} will appear within about half an hour.`, tone: 'ok' });
    setFound(null); setLink('');
    reload();
    return undefined;
  }

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setNote({ text: '', tone: '' });
    const { data, error } = await lookup({ action: 'podcast-search', q });
    setBusy(false);
    if (error) return setNote({ text: error.message, tone: 'error' });
    setResults(data.shows);
    return undefined;
  }

  async function check(e) {
    e.preventDefault();
    const url = normaliseLink(link);
    if (!url) return setNote({ text: 'That link doesn’t look right.', tone: 'error' });
    if (kind === 'youtube' && !youtubeChannelRef(url)) {
      return setNote({ text: 'That looks like a single video. Open the channel’s page and copy that link instead.', tone: 'error' });
    }
    setBusy(true); setNote({ text: '', tone: '' }); setFound(null);
    const { data, error } = await lookup({ action: kind === 'youtube' ? 'youtube-channel' : 'podcast-feed', url });
    setBusy(false);
    if (error) return setNote({ text: error.message, tone: 'error' });
    setFound(data);
    return undefined;
  }

  async function unfollow(s) {
    if (!window.confirm(`Stop following ${s.title || `this ${w.one}`}? Episodes already shared stay.`)) return;
    const { error } = await unfollowSource(s.id);
    if (error) setNote({ text: error.message, tone: 'error' });
    reload();
  }

  return (
    <Sheet title={w.title} onClose={onClose}>
      <p className="hint">{w.help}</p>

      {list === null && <p className="notice">Loading…</p>}
      {list?.length === 0 && <p className="notice">Nothing followed yet.</p>}
      <ul className="plain">
        {list?.map((s) => (
          <li key={s.id} className="source-row">
            <Face image={s.image_url} kind={kind} />
            <span className="grow">
              <strong>{s.title || s.feed_url}</strong>
              <small>
                {s.added_by ? `Added by ${byId.get(s.added_by)?.display_name || 'someone'}` : 'Added'} {ago(s.created_at).toLowerCase()}
                {s.failures > 2 && s.last_error ? ' · having trouble reaching it' : ''}
              </small>
            </span>
            {(s.added_by === profile.id || profile.role === 'admin') && <button className="linkish danger" onClick={() => unfollow(s)}>Unfollow</button>}
          </li>
        ))}
      </ul>

      <h3>{w.add}</h3>
      {kind === 'podcast' && (
        <form onSubmit={search} className="row">
          <input className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={w.search} aria-label={w.search} />
          <button className="primary" disabled={busy || !q.trim()}>Search</button>
        </form>
      )}
      {results && (
        <ul className="plain results">
          {results.length === 0 && <li className="hint">No shows found. Try other words.</li>}
          {results.map((r) => (
            <li key={r.feed_url} className="source-row">
              <Face image={r.image} kind={kind} />
              <span className="grow"><strong>{r.title}</strong>{r.author && <small>{r.author}</small>}</span>
              {followed.has(r.feed_url)
                ? <span className="badge">Following</span>
                : <button className="mini" onClick={() => follow(r)}>Follow</button>}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={check}>
        <label className="label" htmlFor={`src-${kind}`}>{w.paste}</label>
        <div className="row">
          <input id={`src-${kind}`} className="field" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" />
          <button className="mini" disabled={busy || !link.trim()}>{busy ? 'Looking…' : 'Find'}</button>
        </div>
      </form>
      {found && (
        <div className="source-row found">
          <Face image={found.image} kind={kind} />
          <span className="grow"><strong>{found.title}</strong></span>
          {followed.has(found.feed_url) ? <span className="badge">Following</span> : <button className="primary" onClick={() => follow(found)}>Follow</button>}
        </div>
      )}
      <Message tone={note.tone}>{note.text}</Message>
    </Sheet>
  );
}
