import { supabase } from './supabase.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const isStandalone = () =>
  Boolean(window.matchMedia?.('(display-mode: standalone)').matches) || window.navigator.standalone === true;

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// serviceWorker.ready never settles when no worker is registered (dev server), so don't wait forever.
const registration = () =>
  Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no service worker')), 4000))]);

// 'unsupported' | 'needs-install' (iPhone, not on the home screen yet) | 'denied' | 'off' | 'on'
export async function pushState() {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return 'unsupported';
  if (isIos() && !isStandalone()) return 'needs-install';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch {
    return 'unsupported';
  }
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: permission === 'denied' ? 'denied' : 'dismissed' };
  try {
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
    const { error } = await supabase.rpc('register_push', {
      p_endpoint: sub.endpoint,
      p_keys: sub.toJSON().keys,
      p_user_agent: navigator.userAgent,
    });
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', message: e.message };
  }
}

export async function disablePush() {
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch { /* nothing to undo */ }
}
