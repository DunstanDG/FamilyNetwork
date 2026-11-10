import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { appUrl, configured, supabase } from './supabase.js';
import { fetchProfile, peekInvite, redeemInvite, touchLastSeen, updateProfile as saveProfile } from './data.js';
import { get, set, del } from './lib/idb.js';
import { isNetworkError } from './lib/outbox.js';

const INVITE_KEY = 'fn-invite';
const ONBOARDED_KEY = 'fn-onboarded-v1';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const store = {
  read(key) { try { return localStorage.getItem(key); } catch { return memory[key] ?? null; } },
  write(key, value) { memory[key] = value; try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  clear(key) { delete memory[key]; try { localStorage.removeItem(key); } catch { /* private mode */ } },
};
const memory = {};

// An invite link looks like  <app>/?invite=CODE . Keep the code safely through the Google redirect.
export function captureInvite() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('invite');
  if (!code) return;
  store.write(INVITE_KEY, code);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

// Coming back from an emailed sign-in link: the address carries ?code=... (handled by Supabase) or,
// when the link is stale, an error. Note both before anything tidies the address bar.
let linkReturn = { hadCode: false, error: '' };
export function captureAuthReturn() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const errorText = url.searchParams.get('error_description') || hash.get('error_description');
  const errorCode = url.searchParams.get('error_code') || hash.get('error_code');
  linkReturn = { hadCode: url.searchParams.has('code'), error: '' };
  if (errorText || errorCode) {
    linkReturn.error = errorCode === 'otp_expired' || /expired|invalid/i.test(errorText || '')
      ? 'That sign-in link has expired or was already used. Ask for a new one below.'
      : `That sign-in link didn’t work (${errorText || errorCode}). Ask for a new one below.`;
    ['error', 'error_code', 'error_description'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState({}, '', url.pathname + url.search);
  }
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: configured ? 'loading' : 'unconfigured', session: null, profile: null, error: '' });
  const [since, setSince] = useState(null);
  const [invite, setInvite] = useState({ code: store.read(INVITE_KEY), valid: null });
  const [onboarded, setOnboarded] = useState(() => store.read(ONBOARDED_KEY) === '1');
  const loadingUid = useRef(null);

  // Is the stored invite still good? (Works before sign-in.)
  useEffect(() => {
    if (!configured || !invite.code) return;
    peekInvite(invite.code).then(({ data, error }) => setInvite((i) => ({ ...i, valid: error ? null : Boolean(data) })));
  }, [invite.code]);

  const applySession = useCallback(async (session) => {
    if (!session) {
      loadingUid.current = null;
      // A link that came back with a code but no session was opened in a different browser or app
      // from the one that asked for it.
      const error = linkReturn.error || (linkReturn.hadCode
        ? 'That link was opened in a different browser or app from the one you asked from. Ask for a new link here, then open the email on this device and tap the link.'
        : '');
      // Kept (not cleared) here: on start-up this runs more than once with no session, and the
      // message must survive until the person actually signs in.
      if (error) {
        const url = new URL(window.location.href);
        if (url.searchParams.has('code')) { url.searchParams.delete('code'); window.history.replaceState({}, '', url.pathname + url.search); }
      }
      setState({ status: 'signedOut', session: null, profile: null, error });
      return;
    }
    linkReturn = { hadCode: false, error: '' };
    const uid = session.user.id;
    if (loadingUid.current === uid) return;
    loadingUid.current = uid;

    const { data, error } = await fetchProfile(uid);
    if (error) {
      const cached = isNetworkError(error) ? await get(`profile:${uid}`) : null;
      if (cached) {
        setSince((s) => s ?? cached.last_seen_at);
        setState({ status: 'ready', session, profile: cached, error: '' });
      } else {
        loadingUid.current = null;
        setState({ status: 'error', session, profile: null, error: error.message });
      }
      return;
    }
    if (!data) {
      setState({ status: 'needsInvite', session, profile: null, error: '' });
      return;
    }
    set(`profile:${uid}`, data);
    setSince((s) => s ?? data.last_seen_at);
    setState({ status: 'ready', session, profile: data, error: '' });
  }, []);

  useEffect(() => {
    if (!configured) return undefined;
    supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED') return;
      // Never call Supabase from inside this callback directly: it can deadlock the auth lock.
      setTimeout(() => applySession(session), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [applySession]);

  // "Since you last looked": remember when you left, and use it as the line when you come back.
  const uid = state.profile?.id;
  useEffect(() => {
    if (!uid) return undefined;
    let leftAt = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        leftAt = new Date().toISOString();
        touchLastSeen(uid, leftAt).then(() => {});
      } else if (leftAt) {
        setSince(leftAt);
        leftAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [uid]);

  const value = useMemo(() => ({
    ...state,
    since,
    invite,
    needsOnboarding: state.status === 'ready' && !onboarded,
    finishOnboarding() { store.write(ONBOARDED_KEY, '1'); setOnboarded(true); },

    signInGoogle: () => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } }),
    sendCode: (email) => supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: appUrl() } }),
    verifyCode: (email, token) => supabase.auth.verifyOtp({ email, token, type: 'email' }),
    async signOut() {
      await supabase.auth.signOut();
      if (state.profile) del(`profile:${state.profile.id}`);
      loadingUid.current = null;
    },

    async redeem(displayName) {
      const { data, error } = await redeemInvite(invite.code, displayName);
      if (error) return { error: error.message };
      store.clear(INVITE_KEY);
      setInvite({ code: null, valid: null });
      set(`profile:${data.id}`, data);
      setSince(data.last_seen_at);
      setState((s) => ({ ...s, status: 'ready', profile: data }));
      return {};
    },

    async updateProfile(patch) {
      const { data, error } = await saveProfile(state.profile.id, patch);
      if (error) return { error: error.message };
      set(`profile:${data.id}`, data);
      setState((s) => ({ ...s, profile: data }));
      return {};
    },
  }), [state, since, invite, onboarded]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
