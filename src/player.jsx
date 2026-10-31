import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { savePlayback } from './data.js';
import { get, set } from './lib/idb.js';
import { clock, resumeAt } from './lib/media.js';
import { safeImage } from './lib/links.js';

const Ctx = createContext(null);
export const usePlayer = () => useContext(Ctx);

const SAVE_EVERY_MS = 15000;
const local = (postId) => `playback:${postId}`;

// One audio element for the whole app, so an episode keeps playing while you move between tabs.
// The place you're up to is saved to the device straight away and to the server every 15 seconds,
// on pause and at the end, so it follows you to your other devices.
export function PlayerProvider({ children }) {
  const audio = useRef(null);
  const [current, setCurrent] = useState(null); // { postId, title, show, image, src }
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ position: 0, duration: 0 });
  const [error, setError] = useState('');
  const lastSave = useRef(0);

  const persist = useCallback(async (force = false, finished = false) => {
    const el = audio.current;
    if (!el || !current) return;
    const now = Date.now();
    if (!force && now - lastSave.current < SAVE_EVERY_MS) return;
    lastSave.current = now;
    const row = { postId: current.postId, position: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : null, finished };
    await set(local(current.postId), { position_seconds: row.position, duration_seconds: row.duration, finished, updated_at: new Date().toISOString() });
    savePlayback(row).then(() => {}, () => {});
  }, [current]);

  const play = useCallback(async (post) => {
    const el = audio.current;
    const src = post.payload?.audio_url;
    if (!el || !src) return;
    setError('');
    if (current?.postId === post.id) { el.play().catch(() => {}); return; }
    if (current) await persist(true);
    // The device's copy wins if it is newer than what the server sent with the post.
    const server = post.playback?.[0] || null;
    const saved = await get(local(post.id));
    const resume = resumeAt(saved && (!server || saved.updated_at > (server.updated_at || '')) ? saved : server, post.payload?.duration_seconds);
    const next = {
      postId: post.id, src,
      title: post.payload?.title || post.payload?.preview?.title || 'Episode',
      show: post.payload?.source_title || post.payload?.preview?.site || '',
      image: safeImage(post.payload?.image || post.payload?.preview?.image),
    };
    setCurrent(next);
    el.src = src;
    el.currentTime = 0;
    const start = () => {
      if (resume) el.currentTime = resume;
      el.play().catch(() => setError('Tap play to start.'));
    };
    el.addEventListener('loadedmetadata', start, { once: true });
    el.load();
  }, [current, persist]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  }, []);
  const skip = useCallback((by) => {
    const el = audio.current;
    if (el) el.currentTime = Math.max(0, Math.min((el.duration || Infinity) - 1, el.currentTime + by));
  }, []);
  const seek = useCallback((to) => { if (audio.current) audio.current.currentTime = to; }, []);
  const close = useCallback(async () => {
    await persist(true);
    audio.current?.pause();
    setCurrent(null);
  }, [persist]);

  useEffect(() => {
    const el = audio.current;
    if (!el) return undefined;
    const onTime = () => { setTime({ position: el.currentTime, duration: el.duration || 0 }); persist(false); };
    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); persist(true); };
    const onEnded = () => { setPlaying(false); persist(true, true); };
    const onError = () => { setPlaying(false); setError(navigator.onLine ? 'This episode won’t play. The show may have moved it.' : 'You’re offline.'); };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    const onHide = () => { if (document.visibilityState === 'hidden') persist(true); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [persist]);

  // Lock screen and headphone controls.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || !current) return;
    try {
      ms.metadata = new window.MediaMetadata({ title: current.title, artist: current.show, artwork: current.image ? [{ src: current.image, sizes: '512x512' }] : [] });
      ms.setActionHandler('play', toggle);
      ms.setActionHandler('pause', toggle);
      ms.setActionHandler('seekbackward', () => skip(-15));
      ms.setActionHandler('seekforward', () => skip(30));
    } catch { /* older browsers */ }
  }, [current, toggle, skip]);

  useEffect(() => {
    document.body.classList.toggle('has-player', Boolean(current));
  }, [current]);

  const value = useMemo(() => ({ current, playing, time, error, play, toggle, skip, seek, close }), [current, playing, time, error, play, toggle, skip, seek, close]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audio} preload="metadata" />
    </Ctx.Provider>
  );
}

export function MiniPlayer() {
  const p = usePlayer();
  if (!p?.current) return null;
  const { current, playing, time } = p;
  return (
    <section className="mini-player" aria-label="Now playing">
      {current.image ? <img src={current.image} alt="" className="mp-art" /> : <span className="mp-art" aria-hidden="true">🎧</span>}
      <div className="mp-main">
        <p className="mp-title">{current.title}</p>
        <div className="mp-bar">
          <span className="mp-time">{clock(time.position)}</span>
          <input
            type="range" min={0} max={Math.max(1, Math.floor(time.duration))} step={1} value={Math.floor(time.position)}
            onChange={(e) => p.seek(Number(e.target.value))} aria-label="Position in episode"
          />
          <span className="mp-time">{time.duration ? clock(time.duration) : '–:––'}</span>
        </div>
        {p.error && <p className="mp-error" role="alert">{p.error}</p>}
      </div>
      <div className="mp-controls">
        <button className="mp-btn" onClick={() => p.skip(-15)} aria-label="Back 15 seconds">↺15</button>
        <button className="mp-btn big" onClick={p.toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        <button className="mp-btn" onClick={() => p.skip(30)} aria-label="Forward 30 seconds">30↻</button>
        <button className="mp-btn" onClick={p.close} aria-label="Stop and close player">✕</button>
      </div>
    </section>
  );
}
