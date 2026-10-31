// Turning something shared (typed, pasted, or sent from another app) into a post.
import { classifyLink, firstUrl, isAudioUrl, safeImage, youtubeVideoId } from './links.js';
import { normaliseLink } from './timeline.js';

const trimTo = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined);

function cleanPreview(p) {
  if (!p) return undefined;
  const out = {
    title: trimTo(p.title, 200), description: trimTo(p.description, 300), image: safeImage(p.image) || undefined, site: trimTo(p.site, 80),
  };
  return Object.values(out).some(Boolean) ? JSON.parse(JSON.stringify(out)) : undefined;
}

// { kind, body, payload } for a post with an optional link. With no link it's a plain update.
export function buildPost({ text = '', url = null, preview = null }) {
  const body = text.trim();
  const safe = url ? normaliseLink(url) : null;
  if (!safe) return { kind: 'update', body, payload: {} };
  const kind = classifyLink(safe);
  const pv = cleanPreview(preview);
  const payload = { url: safe, ...(pv ? { preview: pv } : {}) };
  if (kind === 'video') {
    payload.video_id = youtubeVideoId(safe);
    if (pv?.title) payload.title = pv.title;
    if (pv?.site) payload.source_title = pv.site;
  }
  if (kind === 'podcast_episode') {
    if (pv?.title) payload.title = pv.title;
    if (pv?.site) payload.source_title = pv.site;
    if (pv?.image) payload.image = pv.image;
    const audio = preview?.audio_url && normaliseLink(preview.audio_url);
    if (audio) payload.audio_url = audio;
    else if (isAudioUrl(safe)) payload.audio_url = safe;
  }
  return { kind, body, payload };
}

// What another app handed us through the share sheet (or the iOS Shortcut): a link, and any words.
// Android often puts the link inside the text, sometimes with the page title in front.
export function readShare(params) {
  const title = (params.get('share_title') || '').trim();
  const text = (params.get('share_text') || '').trim();
  const rawUrl = (params.get('share_url') || '').trim();
  const url = normaliseLink(rawUrl) ? rawUrl : firstUrl(text) || firstUrl(title);
  if (!url && !text && !title) return null;
  let words = text;
  if (url) words = words.replace(url, '').trim();
  if (!words && title && !url) words = title;
  return { url: url ? normaliseLink(url) : null, text: words };
}

export const KIND_NAME = { video: 'Video', podcast_episode: 'Podcast', link: 'News', update: 'Update' };
