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
import { Empty, Ico, PageHead, SkeletonPosts } from './ui.jsx';
import { CalendarDays, CalendarPlus, Headphones, ImagePlus, Images, Newspaper, PlaySquare, Rss, Sparkles } from 'lucide-react';

const FILTERS = [
  { id: 'all', label: 'Everything', kind: null },
  { id: 'update', label: 'Updates', kind: 'update' },
  { id: 'photo_album', label: 'Photos', kind: 'photo_album' },
  { id: 'podcast_episode', label: 'Podcasts', kind: 'podcast_episode' },
  { id: 'video', label: 'Videos', kind: 'video' },
  { id: 'link', label: 'News', kind: 'link' },
  { id: 'event', label: 'Calendar', kind: 'event' },
];

const firstName = (name = '') => name.trim().split(/\s+/)[0] || '';
function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// The header and "add something" area at the top of each tab.
function Toolbar({ module }) {
  const { profile } = useAuth();
  const [sheet, setSheet] = useState(null);
  const close = () => setSheet(null);
  switch (module.id) {
    case 'home':
      return (
        <>
          <PageHead title={`${greeting()}, ${firstName(profile.display_name)}`} sub="Here’s what the family has been sharing." />
          <Upcoming />
          <Composer />
        </>
      );
    case 'calendar':
      return (
        <>
          <PageHead title="Calendar" sub="Plan get-togethers and see what’s coming up.">
            <button className="primary" onClick={() => setSheet('event')}><Ico as={CalendarPlus} />Plan something</button>
          </PageHead>
          <Upcoming limit={10} />
          {sheet && <ProposeEvent onClose={close} />}
        </>
      );
    case 'podcasts':
      return (
        <>
          <PageHead title="Podcasts" sub="Episodes the family is listening to.">
            <button className="mini" onClick={() => setSheet('podcast')}><Ico as={Rss} />Shows we follow</button>
          </PageHead>
          <Composer linkFirst linkHint="Paste a link to a podcast episode" />
          {sheet && <SourcesSheet kind="podcast" onClose={close} />}
        </>
      );
    case 'videos':
      return (
        <>
          <PageHead title="Videos" sub="Worth watching: shared by the family, or new from channels we follow.">
            <button className="mini" onClick={() => setSheet('youtube')}><Ico as={Rss} />Channels we follow</button>
          </PageHead>
          <Composer linkFirst linkHint="Paste a YouTube link" />
          {sheet && <SourcesSheet kind="youtube" onClose={close} />}
        </>
      );
    case 'news':
      return (
        <>
          <PageHead title="News" sub="Articles and links the family has shared." />
          <Composer linkFirst linkHint="Paste a link to an article" />
        </>
      );
    case 'photos':
      return (
        <>
          <PageHead title="Photos" sub="Albums from the family, kept on our own server.">
            {photosConfigured && <button className="primary" onClick={() => setSheet('album')}><Ico as={ImagePlus} />New album</button>}
          </PageHead>
          {!photosConfigured && (
            <p className="soon">Photos need the family’s photo server. Ask whoever runs the app to set it up (see the README).</p>
          )}
          {sheet && <NewAlbum onClose={close} />}
        </>
      );
    default: return null;
  }
}

const EMPTY = {
  home: { icon: Sparkles, title: 'Nothing here yet', text: 'Be the first to share something: news, a photo, or something worth watching.' },
  photos: { icon: Images, title: 'No albums yet', text: 'Start one with photos from a recent get-together.' },
  podcasts: { icon: Headphones, title: 'No episodes yet', text: 'Share an episode you enjoyed, or follow a show so new ones appear here.' },
  videos: { icon: PlaySquare, title: 'No videos yet', text: 'Paste a YouTube link above, or follow a channel.' },
  news: { icon: Newspaper, title: 'No links yet', text: 'Paste a link to an article you think the family would like.' },
  calendar: { icon: CalendarDays, title: 'Nothing planned yet', text: 'Suggest a few dates and places, and let the family vote.' },
};

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


      {feed.status === 'loading' && <div className="timeline" aria-busy="true" aria-label="Loading"><SkeletonPosts /></div>}
      {feed.status === 'error' && (
        <p className="msg error" role="alert">
          Couldn’t load the timeline. {feed.error}{' '}
          <button className="linkish" onClick={feed.reload}>Try again</button>
        </p>
      )}
      {feed.status === 'offline' && <p className="msg">Showing what was saved on this device. It will update when you’re back online.</p>}

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

      {empty && (() => {
        const e = isHome && filter !== 'all' ? { ...EMPTY.home, title: 'Nothing of this kind yet', text: 'Try another filter, or share something yourself.' } : EMPTY[module.id];
        return <Empty icon={e.icon} title={e.title}>{e.text}</Empty>;
      })()}
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
