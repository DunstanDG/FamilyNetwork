import { useEffect, useState } from 'react';
import { fetchNotifications, fetchPost, markAllRead } from '../data.js';
import { ago } from '../lib/time.js';
import { useOnChanged } from '../hooks.js';
import PostCard from './PostCard.jsx';
import { Empty, Ico, PersonAvatar, Sheet, SkeletonPosts } from './ui.jsx';
import { BellRing, CalendarDays, Images } from 'lucide-react';

const WHAT = {
  mention: 'mentioned you',
  reply: 'replied to you',
  album: 'shared new photos',
  vote: 'asked for your vote',
  event: 'updated an event',
};
// Notifications with nobody behind them: the calendar deciding by itself, or a reminder.
const SYSTEM = { event: 'Family plans', vote: 'Family plans', album: 'New photos' };

export function NotificationsSheet({ onClose, onOpenPost, onRead }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchNotifications().then(async ({ data }) => {
      if (!alive) return;
      setItems(data || []);
      if ((data || []).some((n) => !n.read_at)) {
        await markAllRead();
        onRead?.();
      }
    });
    return () => { alive = false; };
  }, [onRead]);

  return (
    <Sheet title="Notifications" onClose={onClose}>
      {items === null && <div style={{ marginTop: 12 }}><SkeletonPosts count={2} /></div>}
      {items?.length === 0 && <div style={{ marginTop: 12 }}><Empty icon={BellRing} title="You’re all caught up">Mentions, replies, new photos and plans will appear here.</Empty></div>}
      <ul className="plain">
        {items?.map((n) => (
          <li key={n.id}>
            <button className={`alert-row ${n.read_at ? '' : 'unread'}`} onClick={() => onOpenPost(n.post_id)}>
              {n.actor ? <PersonAvatar person={n.actor} size={40} /> : <span className="avatar source icon" style={{ width: 40, height: 40 }}><Ico as={n.kind === 'album' ? Images : CalendarDays} size={20} /></span>}
              <span className="grow">
                {n.actor ? <><strong>{n.actor.display_name}</strong> {WHAT[n.kind] || 'did something'}</> : <strong>{SYSTEM[n.kind] || 'Family Network'}</strong>}
                {n.snippet && <small>“{n.snippet}”</small>}
                <small>{ago(n.created_at)}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

// A single post opened from a notification or a push tap.
export function PostSheet({ postId, onClose }) {
  const [state, setState] = useState({ loading: true, post: null, error: '' });

  const load = async () => {
    const { data, error } = await fetchPost(postId);
    setState({ loading: false, post: data, error: error ? error.message : '' });
  };
  useEffect(() => { setState({ loading: true, post: null, error: '' }); load(); }, [postId]); // eslint-disable-line react-hooks/exhaustive-deps
  useOnChanged(load);

  return (
    <Sheet title="Post" onClose={onClose} wide>
      {state.loading && <p className="notice">Loading…</p>}
      {state.error && <p className="msg error" role="alert">Couldn’t open this post. {state.error}</p>}
      {!state.loading && !state.error && !state.post && <p className="notice">This post is no longer available.</p>}
      {state.post && <PostCard post={state.post} highlight />}
    </Sheet>
  );
}
