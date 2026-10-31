import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth.jsx';
import { MembersProvider } from './members.jsx';
import { OutboxProvider } from './outbox.jsx';
import { supabase } from './supabase.js';
import { countUnread } from './data.js';
import { MODULES } from './lib/timeline.js';
import { useOnChanged, useOnline } from './hooks.js';
import { ErrorScreen, Join, SignIn, Splash, Unconfigured } from './screens.jsx';
import Feed from './components/Feed.jsx';
import Onboarding from './components/Onboarding.jsx';
import People from './components/People.jsx';
import Settings from './components/Settings.jsx';
import { NotificationsSheet, PostSheet } from './components/Alerts.jsx';
import { PersonAvatar } from './components/ui.jsx';

const TAB_KEY = 'fn-tab';
const readTab = () => {
  try { const t = localStorage.getItem(TAB_KEY); return MODULES.some((m) => m.id === t) ? t : 'home'; } catch { return 'home'; }
};

function Shell() {
  const { profile, needsOnboarding, finishOnboarding } = useAuth();
  const online = useOnline();
  const [tab, setTab] = useState(readTab);
  const [sheet, setSheet] = useState(null); // 'people' | 'settings' | 'alerts'
  const [postId, setPostId] = useState(() => new URLSearchParams(window.location.search).get('post'));
  const [unread, setUnread] = useState(0);

  // A link from a notification opens that post; tidy the address afterwards.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('post')) {
      url.searchParams.delete('post');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
    const onMessage = (e) => { if (e.data?.type === 'open-post' && e.data.postId) setPostId(e.data.postId); };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);

  const refreshUnread = useCallback(async () => {
    const { count } = await countUnread();
    if (typeof count === 'number') setUnread(count);
  }, []);
  useEffect(() => { refreshUnread(); }, [refreshUnread]);
  useOnChanged(refreshUnread);
  useEffect(() => {
    const channel = supabase.channel(`alerts-${profile.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'family', table: 'notifications', filter: `user_id=eq.${profile.id}` }, refreshUnread)
      .subscribe();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshUnread(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { supabase.removeChannel(channel); document.removeEventListener('visibilitychange', onVisible); };
  }, [profile.id, refreshUnread]);

  const choose = (id) => {
    setTab(id);
    try { localStorage.setItem(TAB_KEY, id); } catch { /* fine */ }
    window.scrollTo({ top: 0 });
  };
  const module = MODULES.find((m) => m.id === tab) || MODULES[0];
  const closeSheet = useCallback(() => setSheet(null), []);
  const closePost = useCallback(() => setPostId(null), []);

  return (
    <>
      <header className="top">
        <h1>Family Network</h1>
        <div className="top-actions">
          <button className="icon-btn" onClick={() => setSheet('alerts')} aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
            🔔{unread > 0 && <span className="dot" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </button>
          <button className="icon-btn" onClick={() => setSheet('people')} aria-label="Our family">👪</button>
          <button className="icon-btn me-btn" onClick={() => setSheet('settings')} aria-label="Your settings">
            <PersonAvatar person={profile} size={40} />
          </button>
        </div>
      </header>

      {!online && <p className="offline" role="status">You’re offline. You can still read, and anything you write will send when you’re back.</p>}

      <main className="page">
        <Feed key={module.id} module={module} />
      </main>

      <nav className="tabs" aria-label="Sections">
        {MODULES.map((m) => (
          <button key={m.id} className={m.id === tab ? 'on' : ''} aria-current={m.id === tab ? 'page' : undefined} onClick={() => choose(m.id)}>
            <span className="tab-icon" aria-hidden="true">{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </nav>

      {sheet === 'people' && <People onClose={closeSheet} />}
      {sheet === 'settings' && <Settings onClose={closeSheet} />}
      {sheet === 'alerts' && (
        <NotificationsSheet
          onClose={closeSheet} onRead={refreshUnread}
          onOpenPost={(id) => { setSheet(null); setPostId(id); }}
        />
      )}
      {postId && <PostSheet postId={postId} onClose={closePost} />}
      {needsOnboarding && <Onboarding onDone={finishOnboarding} />}
    </>
  );
}

function Gate() {
  const { status } = useAuth();
  switch (status) {
    case 'unconfigured': return <Unconfigured />;
    case 'loading': return <Splash />;
    case 'signedOut': return <SignIn />;
    case 'needsInvite': return <Join />;
    case 'error': return <ErrorScreen />;
    default:
      return (
        <MembersProvider>
          <OutboxProvider>
            <Shell />
          </OutboxProvider>
        </MembersProvider>
      );
  }
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
