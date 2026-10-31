// Links shared into the app from another app (Android share sheet) or the iOS Shortcut arrive as
//   <app>/?share_url=...&share_text=...&share_title=...
// Keep them through sign-in, tidy the address bar, and hand them to the composer once signed in.
import { readShare } from './lib/share.js';

const KEY = 'fn-share';

export function captureShare() {
  const url = new URL(window.location.href);
  const shared = readShare(url.searchParams);
  ['share_url', 'share_text', 'share_title'].forEach((k) => url.searchParams.delete(k));
  if (!shared) return;
  try { sessionStorage.setItem(KEY, JSON.stringify(shared)); } catch { window.__fnShare = shared; }
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

export function takeShare() {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  const s = window.__fnShare || null;
  window.__fnShare = null;
  return s;
}
