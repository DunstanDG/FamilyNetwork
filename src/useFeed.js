import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase.js';
import { PAGE_SIZE, fetchPinned, fetchPosts } from './data.js';
import { get, set } from './lib/idb.js';
import { mergePosts } from './lib/timeline.js';
import { useOnChanged } from './hooks.js';

// Loads one timeline (everything, or one kind of post), keeps it fresh through live updates, and
// falls back to the copy saved on the device when there is no connection.
export function useFeed(kind) {
  const cacheKey = `feed:${kind || 'all'}`;
  const [pinned, setPinned] = useState([]);
  const [posts, setPosts] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | offline | error
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pagedFurther = useRef(false);
  const timer = useRef(null);

  const reload = useCallback(async () => {
    const [page, pins] = await Promise.all([fetchPosts({ kind }), fetchPinned({ kind })]);
    if (page.error || pins.error) {
      const err = page.error || pins.error;
      setError(err.message);
      setStatus((s) => (s === 'ready' || s === 'offline' ? 'offline' : navigator.onLine ? 'error' : 'offline'));
      return;
    }
    setPinned(pins.data);
    setPosts((existing) => mergePosts(page.data, existing));
    if (!pagedFurther.current) setHasMore(page.data.length === PAGE_SIZE);
    setStatus('ready');
    setError('');
    set(cacheKey, { pinned: pins.data, posts: page.data });
  }, [kind, cacheKey]);

  // Show the saved copy straight away, then refresh.
  useEffect(() => {
    let cancelled = false;
    pagedFurther.current = false;
    setPosts([]); setPinned([]); setStatus('loading');
    get(cacheKey).then((cached) => {
      if (cancelled || !cached) return;
      setPinned(cached.pinned || []);
      setPosts((cur) => (cur.length ? cur : cached.posts || []));
      setStatus((s) => (s === 'loading' ? 'offline' : s));
    });
    reload();
    return () => { cancelled = true; };
  }, [cacheKey, reload]);

  const reloadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 400);
  }, [reload]);

  useOnChanged(reload);

  // Live updates from other people.
  useEffect(() => {
    const channel = supabase.channel(`feed-${cacheKey}-${Math.random().toString(36).slice(2)}`);
    ['posts', 'comments', 'reactions', 'photo_assets', 'events', 'event_votes', 'event_rsvps'].forEach((table) =>
      channel.on('postgres_changes', { event: '*', schema: 'family', table }, reloadSoon));
    channel.subscribe();
    return () => { clearTimeout(timer.current); supabase.removeChannel(channel); };
  }, [cacheKey, reloadSoon]);

  // Coming back to the app, or back online, refreshes.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', reload);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', reload); };
  }, [reload]);

  const loadMore = useCallback(async () => {
    const last = posts[posts.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    const { data, error: err } = await fetchPosts({ kind, before: last.created_at });
    setLoadingMore(false);
    if (err) { setError(err.message); return; }
    pagedFurther.current = true;
    setPosts((cur) => [...cur, ...data.filter((p) => !cur.some((c) => c.id === p.id))]);
    setHasMore(data.length === PAGE_SIZE);
  }, [kind, posts, loadingMore]);

  return { pinned, posts, status, error, hasMore, loadingMore, loadMore, reload };
}
