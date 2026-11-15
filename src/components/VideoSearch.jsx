import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { supabase } from '../supabase.js';
import { fetchReviews, fetchVerdicts, logVideo, searchVideos, setChannelTier } from '../data.js';
import { useOnline } from '../hooks.js';
import { youtubeEmbed, youtubeThumb } from '../lib/links.js';
import { ago } from '../lib/time.js';
import { CHECK_TIMEOUT_MS, SYNTHETIC_LABEL, clock, describeVerdict, stillChecking, withVerdicts } from '../lib/verdicts.js';
import { Ico, Message, Sheet } from './ui.jsx';
import { CircleCheck, EyeOff, Loader, Search, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';

const ICONS = { ok: CircleCheck, warn: TriangleAlert, wait: Loader, gone: EyeOff };

// The line under each result (and under the player) that says what we know about the channel.
function Flag({ item, waited }) {
  const v = describeVerdict(item, waited);
  const Icon = ICONS[v.tone];
  return (
    <span className={`flag ${v.tone}`}>
      {Icon && <Ico as={Icon} size={15} className={v.tone === 'wait' ? 'spin' : ''} />}{v.label}
    </span>
  );
}

// Admins can settle a channel on the spot.
function Verdicts({ channelId, current, onSet, busy }) {
  const options = [['trusted', 'Trust'], ['caution', 'Take care'], ['blocked', 'Block']];
  return (
    <span className="row wraps" role="group" aria-label="Your verdict on this channel">
      {options.map(([tier, label]) => (
        <button key={tier} className={`mini ${tier === 'blocked' ? 'danger' : ''}`} disabled={busy} aria-pressed={current === tier} onClick={() => onSet(channelId, tier)}>
          {label}
        </button>
      ))}
    </span>
  );
}

function ReviewQueue({ onSet, busy, version }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    let live = true;
    fetchReviews().then(({ data }) => { if (live) setList(data || []); });
    return () => { live = false; };
  }, [version]);
  if (!list?.length) return null;
  return (
    <section aria-label="Channels to review">
      <h3>For admins: channels to look at ({list.length})</h3>
      <p className="hint">Someone gave these a thumbs-down, or the automatic check wasn’t sure. Your verdict is final and applies to every search.</p>
      <ul className="plain">
        {list.map((r) => {
          const c = Array.isArray(r.channel) ? r.channel[0] : r.channel;
          return (
            <li key={r.id} className="review-row">
              <span className="grow">
                <a href={`https://www.youtube.com/channel/${r.channel_id}`} target="_blank" rel="noopener noreferrer"><strong>{c?.title || 'Unnamed channel'}</strong></a>
                <small>
                  {r.why === 'dislike' ? 'Thumbs-down' : 'Check wasn’t sure'} {ago(r.created_at).toLowerCase()}
                  {c?.note ? ` · ${c.note}` : ''}
                </small>
                {c && <Flag item={c} waited={CHECK_TIMEOUT_MS} />}
              </span>
              <Verdicts channelId={r.channel_id} current={c?.source === 'admin' ? c.tier : null} onSet={onSet} busy={busy} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Open YouTube search. Everything shows at once; warnings land on each result as its channel is
// checked. Results never reorder, and a channel found to be junk is replaced in place by one line.
export default function VideoSearch({ onClose }) {
  const { profile } = useAuth();
  const online = useOnline();
  const admin = profile.role === 'admin';
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);       // { results, hidden, at }
  const [verdicts, setVerdicts] = useState({});   // channel_id -> newest row
  const [playing, setPlaying] = useState(null);
  const [rated, setRated] = useState({});         // video_id -> 'like' | 'dislike'
  const [note, setNote] = useState({ text: '', tone: '' });
  const [now, setNow] = useState(Date.now());
  const [settling, setSettling] = useState(false);
  const [reviewVersion, setReviewVersion] = useState(0);
  const playerRef = useRef(null);

  const results = useMemo(() => (found ? withVerdicts(found.results, verdicts) : []), [found, verdicts]);
  const waited = found ? now - found.at : 0;
  const waiting = stillChecking(results) && waited < CHECK_TIMEOUT_MS * 3;
  const current = playing ? results.find((r) => r.video_id === playing.video_id) || playing : null;

  // Verdicts arrive over Realtime as the function writes them...
  useEffect(() => {
    const channel = supabase.channel('yt-verdicts')
      .on('postgres_changes', { event: '*', schema: 'family', table: 'yt_channels' }, (e) => {
        if (e.new?.channel_id) setVerdicts((old) => ({ ...old, [e.new.channel_id]: e.new }));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // ...and, in case a message is missed, by asking every few seconds while anything is still waiting.
  const refresh = useCallback(async () => {
    const ids = [...new Set((found?.results || []).map((r) => r.channel_id))];
    if (!ids.length) return;
    const { data } = await fetchVerdicts(ids);
    if (data) setVerdicts((old) => ({ ...old, ...Object.fromEntries(data.map((r) => [r.channel_id, r])) }));
  }, [found]);
  useEffect(() => {
    if (!waiting) return undefined;
    const tick = setInterval(() => { setNow(Date.now()); refresh(); }, 4000);
    return () => clearInterval(tick);
  }, [waiting, refresh]);

  async function search(e) {
    e.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true); setNote({ text: '', tone: '' });
    const { data, error } = await searchVideos(q);
    setBusy(false);
    if (error) return setNote({ text: error.message, tone: 'error' });
    setVerdicts({}); setPlaying(null);
    setFound({ results: data.results || [], hidden: data.hidden || 0, at: Date.now() });
    setNow(Date.now());
    return undefined;
  }

  function play(item) {
    setPlaying(item);
    // Supabase only sends a request once it is awaited; a failed log must never stop the video.
    logVideo('play', item).then(() => {}, () => {});
    requestAnimationFrame(() => playerRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  async function rate(kind) {
    if (!current || rated[current.video_id]) return;
    setRated((old) => ({ ...old, [current.video_id]: kind }));
    const { error } = await logVideo(kind, current);
    if (error) {
      setRated((old) => { const next = { ...old }; delete next[current.video_id]; return next; });
      return setNote({ text: error.message, tone: 'error' });
    }
    if (kind === 'dislike') setNote({ text: 'Thanks. An admin will take a look at this channel.', tone: 'ok' });
    setReviewVersion((n) => n + 1);
    return undefined;
  }

  async function settle(channelId, tier) {
    setSettling(true); setNote({ text: '', tone: '' });
    const { error } = await setChannelTier(channelId, tier);
    setSettling(false);
    if (error) return setNote({ text: error.message, tone: 'error' });
    setVerdicts((old) => ({ ...old, [channelId]: { ...(old[channelId] || {}), channel_id: channelId, tier, reason: 'admin', source: 'admin' } }));
    setReviewVersion((n) => n + 1);
    return undefined;
  }

  return (
    <Sheet title="Search YouTube" onClose={onClose} wide>
      <form onSubmit={search} className="row">
        <input
          className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100}
          placeholder="What would you like to watch?" aria-label="Search YouTube" autoFocus enterKeyHint="search"
        />
        <button className="primary" disabled={busy || !q.trim() || !online}><Ico as={Search} />{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {!online && <p className="hint">Searching needs a connection.</p>}
      {!found && !busy && (
        <p className="hint">Every channel is checked as you search. Anything doubtful gets a warning, and channels known to be junk are left out.</p>
      )}
      <Message tone={note.tone}>{note.text}</Message>

      {current && (
        <div className="video yt-player" ref={playerRef}>
          <div className="video-frame">
            <iframe
              key={current.video_id} src={youtubeEmbed(current.video_id)} title={current.title || 'YouTube video'}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
          <p className="media-caption"><strong>{current.title}</strong><span>{current.channel_title}</span></p>
          <p className="flags" aria-live="polite">
            {current.tier === 'blocked'
              ? <span className="flag warn"><Ico as={TriangleAlert} size={15} />{describeVerdict(current).label.replace('Removed:', 'This channel is now blocked:')}</span>
              : <Flag item={current} waited={waited} />}
            {current.synthetic && <span className="flag warn"><Ico as={TriangleAlert} size={15} />{SYNTHETIC_LABEL}</span>}
          </p>
          <div className="row wraps">
            <button className="mini" onClick={() => rate('like')} disabled={Boolean(rated[current.video_id])} aria-pressed={rated[current.video_id] === 'like'}>
              <Ico as={ThumbsUp} />Good
            </button>
            <button className="mini" onClick={() => rate('dislike')} disabled={Boolean(rated[current.video_id])} aria-pressed={rated[current.video_id] === 'dislike'}>
              <Ico as={ThumbsDown} />Not good
            </button>
            {admin && <Verdicts channelId={current.channel_id} current={verdicts[current.channel_id]?.source === 'admin' ? current.tier : null} onSet={settle} busy={settling} />}
          </div>
        </div>
      )}

      {found && results.length === 0 && <p className="notice">Nothing found. Try other words.</p>}
      <ul className="plain yt-results" aria-busy={waiting}>
        {results.map((r) => {
          if (r.tier === 'blocked') {
            return <li key={r.video_id} className="yt-gone"><Flag item={r} waited={waited} /></li>;
          }
          return (
            <li key={r.video_id}>
              <button className={`yt-card ${current?.video_id === r.video_id ? 'on' : ''}`} onClick={() => play(r)} aria-label={`Play ${r.title}, from ${r.channel_title}`}>
                <span className="yt-thumb">
                  <img src={youtubeThumb(r.video_id)} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  {clock(r.duration_seconds) && <span className="yt-length">{clock(r.duration_seconds)}</span>}
                </span>
                <span className="grow">
                  <strong>{r.title}</strong>
                  <small>{r.channel_title}{r.published_at ? ` · ${ago(r.published_at)}` : ''}</small>
                  <Flag item={r} waited={waited} />
                  {r.synthetic && <span className="flag warn"><Ico as={TriangleAlert} size={15} />{SYNTHETIC_LABEL}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {found?.hidden > 0 && (
        <p className="hint">{found.hidden === 1 ? '1 result was' : `${found.hidden} results were`} left out because the channel is blocked.</p>
      )}

      {admin && <ReviewQueue onSet={settle} busy={settling} version={reviewVersion} />}
    </Sheet>
  );
}
