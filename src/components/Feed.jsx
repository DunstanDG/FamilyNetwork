import { useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useOutbox } from '../outbox.jsx';
import { useFeed } from '../useFeed.js';
import { findUnreadDivider } from '../lib/timeline.js';
import Composer from './Composer.jsx';
import PostCard from './PostCard.jsx';
import SourcesSheet from './Sources.jsx';
import { NewAlbum } from './Photos.jsx';
import { photosConfigured } from '../photos.js';
import { ProposeEvent, Upcoming } from './Calendar.jsx';

const FILTERS = [
  { id: 'all', label: 'Everything', kind: null },
  { id: 'update', label: 'Updates', kind: 'update' },
  { id: 'photo_album', label: 'Photos', kind: 'photo_album' },
  { id: 'podcast_episode', label: 'Podcasts', kind: 'podcast_episode' },
  { id: 'video', label: 'Videos', kind: 'video' },
  { id: 'link', label: 'News', kind: 'link' },
  { id: 'event', label: 'Calendar', kind: 'event' },
];

// What sits above each tab's timeline: a way to add to it.
function Toolbar({ module }) {
  const [sheet, setSheet] = useState(null);
  switch (module.id) {
    case 'home': return <><Upcoming /><Composer /></>;
    case 'calendar':
      return (
        <>
          <Upcoming limit={10} />
          <button className="primary wide add-big" onClick={() => setSheet('event')}>📅 Plan something</button>
          {sheet && <ProposeEvent onClose={() => setSheet(null)} />}
        </>
      );
    case 'podcasts':
      return (
        <>
          <div className="toolbar">
            <button className="mini" onClick={() => setSheet('podcast')}>🎧 Shows we follow</button>
          </div>
          <Composer linkFirst linkHint="Paste a link to a podcast episode" />
          {sheet && <SourcesSheet kind="podcast" onClose={() => setSheet(null)} />}
        </>
      );
    case 'videos':
      return (
        <>
          <div className="toolbar">
            <button className="mini" onClick={() => setSheet('youtube')}>▶️ Channels we follow</button>
          </div>
          <Composer linkFirst linkHint="Paste a YouTube link" />
          {sheet && <SourcesSheet kind="youtube" onClose={() => setSheet(null)} />}
        </>
      );
    case 'news': return <Composer linkFirst linkHint="Paste a link to an article" />;
    case 'photos':
      return photosConfigured ? (
        <>
          <button className="primary wide add-big" onClick={() => setSheet('album')}>📷 New album</button>
          {sheet && <NewAlbum onClose={() => setSheet(null)} />}
        </>
      ) : <p className="soon">Photos need the family’s photo server. Ask whoever runs the app to set it up (see the README).</p>;
    default: return null;
  }
}

export default function Feed({ module }) {
  const isHome = module.id === 'home';
  const [filter, setFilter] = useState('all');
  const kind = isHome ? FILTERS.find((f) => f.id === filter).kind : module.kind;
  const { profile, since } = useAuth();
  const outbox = useOutbox();
  const feed = useFeed(kind);

  const queued = useMemo(() => {
    const loaded = new Set([...feed.pinned, ...feed.posts].map((p) => p.id));
    return [...outbox.items, ...outbox.settled].filter((i) => i.type === 'post' && !loaded.has(i.id) && (!kind || i.data.kind === kind)).map((i) => ({
      ...i.data, author_id: profile.id, author: profile, created_at: new Date(i.queuedAt).toISOString(),
      reactions: [], comments: [], pinned: false, _pending: true, _failed: i.failed, _outboxId: i.id,
    })).reverse();
  }, [outbox.items, outbox.settled, kind, profile, feed.pinned, feed.posts]);

  const divider = useMemo(() => findUnreadDivider(feed.posts, since, profile.id), [feed.posts, since, profile.id]);
  const empty = feed.status === 'ready' && !feed.pinned.length && !feed.posts.length && !queued.length;

  return (
    <section aria-label={module.label}>
      <Toolbar module={module} />

      {isHome && (
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} className={`chip ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      )}


      {feed.status === 'loading' && <p className="notice">Loading…</p>}
      {feed.status === 'error' && (
        <p className="msg error" role="alert">
          Couldn’t load the timeline. {feed.error}{' '}
          <button className="linkish" onClick={feed.reload}>Try again</button>
        </p>
      )}
      {feed.status === 'offline' && <p className="notice">Showing what was saved on this device. It will update when you’re back online.</p>}

      <div className="timeline">
        {queued.map((p) => <PostCard key={p.id} post={p} />)}
        {feed.pinned.map((p) => <PostCard key={p.id} post={p} />)}
        {feed.posts.map((p, i) => (
          <div key={p.id}>
            {divider?.index === i && <UnreadLine count={divider.count} />}
            <PostCard post={p} />
          </div>
        ))}
        {divider && divider.index >= feed.posts.length && <UnreadLine count={divider.count} />}
      </div>

      {empty && <p className="notice center-text">Nothing here yet. Be the first to share something.</p>}
      {feed.hasMore && (
        <button className="mini wide" onClick={feed.loadMore} disabled={feed.loadingMore}>
          {feed.loadingMore ? 'Loading…' : 'Show older posts'}
        </button>
      )}
    </section>
  );
}

function UnreadLine({ count }) {
  return (
    <div className="unread-line" role="separator" aria-label={`${count} new since you last looked`}>
      <span>{count} new since you last looked</span>
    </div>
  );
}
