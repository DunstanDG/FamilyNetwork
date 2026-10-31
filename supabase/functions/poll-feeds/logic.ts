// Pure decisions for the feed poller, kept free of Deno APIs so they can be unit tested.
// `parseFeed` takes a document already parsed by fast-xml-parser with XML_OPTIONS.
import { safeImage, youtubeVideoId } from '../_shared/links.js';

export const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
};

export interface FeedItem {
  guid: string;
  title: string;
  url: string | null;
  published_at: string | null;
  audio_url: string | null;
  duration_seconds: number | null;
  image: string | null;
  video_id: string | null;
  description: string;
}

export interface Feed {
  title: string;
  image: string | null;
  link: string | null;
  items: FeedItem[];
}

export interface SourceState {
  kind: 'podcast' | 'youtube';
  last_polled_at: string | null;
  failures: number;
}

type Node = Record<string, unknown> | string | undefined | null;

const list = (x: unknown): unknown[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

function text(x: unknown): string {
  if (x === undefined || x === null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x).trim();
  if (Array.isArray(x)) return text(x[0]);
  if (typeof x === 'object') return text((x as Record<string, unknown>)['#text']);
  return '';
}

const attr = (x: Node, name: string): string => (x && typeof x === 'object' ? text((x as Record<string, unknown>)[`@_${name}`]) : '');

function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function isoDate(raw: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// "1:02:03", "62:03", "3723" or "3723.5" -> seconds
export function parseDuration(raw: unknown): number | null {
  const s = text(raw);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map((p) => Number(p));
  if (parts.length > 3 || parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// Strip tags and squash whitespace: descriptions are shown as plain text, never as HTML.
export function plain(html: string, max = 400): string {
  const s = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function rssItem(it: Record<string, unknown>, channelImage: string | null): FeedItem | null {
  const enclosure = list(it.enclosure).find((e) => /^audio\//i.test(attr(e as Node, 'type')) || attr(e as Node, 'url')) as Node;
  const audio = enclosure ? httpUrl(attr(enclosure, 'url')) : null;
  const link = httpUrl(text(it.link));
  const guid = text(it.guid) || audio || link || text(it.title);
  if (!guid) return null;
  const image = safeImage(attr(it['itunes:image'] as Node, 'href')) || channelImage;
  return {
    guid: guid.slice(0, 500),
    title: text(it.title).slice(0, 300) || 'Untitled episode',
    url: link,
    published_at: isoDate(text(it.pubDate) || text(it['dc:date'])),
    audio_url: audio,
    duration_seconds: parseDuration(it['itunes:duration']),
    image,
    video_id: null,
    description: plain(text(it['itunes:summary']) || text(it.description)),
  };
}

function atomItem(e: Record<string, unknown>): FeedItem | null {
  const links = list(e.link) as Node[];
  const alt = links.find((l) => !attr(l, 'rel') || attr(l, 'rel') === 'alternate') || links[0];
  const url = alt ? httpUrl(attr(alt, 'href')) : null;
  const group = (e['media:group'] || {}) as Record<string, unknown>;
  const videoId = text(e['yt:videoId']) || (url ? youtubeVideoId(url) : null);
  const guid = text(e.id) || url || '';
  if (!guid) return null;
  return {
    guid: guid.slice(0, 500),
    title: (text(e.title) || text(group['media:title'])).slice(0, 300) || 'Untitled',
    url,
    published_at: isoDate(text(e.published) || text(e.updated)),
    audio_url: null,
    duration_seconds: null,
    image: safeImage(attr(group['media:thumbnail'] as Node, 'url')) || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null),
    video_id: videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null,
    description: plain(text(group['media:description'])),
  };
}

export function parseFeed(doc: Record<string, unknown>): Feed {
  const rss = doc.rss as Record<string, unknown> | undefined;
  if (rss) {
    const ch = (list(rss.channel)[0] || {}) as Record<string, unknown>;
    const image = safeImage(attr(ch['itunes:image'] as Node, 'href')) || safeImage(text((ch.image as Record<string, unknown>)?.url));
    const items = list(ch.item).map((it) => rssItem(it as Record<string, unknown>, image)).filter(Boolean) as FeedItem[];
    return { title: text(ch.title).slice(0, 200), image, link: httpUrl(text(ch.link)), items: newestFirst(items) };
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    const items = list(feed.entry).map((e) => atomItem(e as Record<string, unknown>)).filter(Boolean) as FeedItem[];
    const alt = (list(feed.link) as Node[]).find((l) => attr(l, 'rel') === 'alternate');
    return { title: text(feed.title).slice(0, 200), image: null, link: alt ? httpUrl(attr(alt, 'href')) : null, items: newestFirst(items) };
  }
  throw new Error('not an RSS or Atom feed');
}

function newestFirst(items: FeedItem[]): FeedItem[] {
  // Undated items keep their feed order, which for RSS is almost always newest first.
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ta = a.it.published_at ? Date.parse(a.it.published_at) : null;
      const tb = b.it.published_at ? Date.parse(b.it.published_at) : null;
      if (ta !== null && tb !== null && ta !== tb) return tb - ta;
      return a.i - b.i;
    })
    .map(({ it }) => it);
}

export const MAX_NEW_PER_POLL = 5;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Which items to post, and which to only record as seen.
// First poll of a newly followed show: post just the latest one, so following a show with 500
// episodes doesn't flood anyone. After that: post anything new from the last fortnight, a few at a time.
export function pickNew(items: FeedItem[], seen: Set<string>, firstPoll: boolean, now = Date.now()) {
  const fresh = items.filter((it) => !seen.has(it.guid));
  if (firstPoll) return { post: fresh.slice(0, 1), skip: fresh.slice(1) };
  const recent = fresh.filter((it) => !it.published_at || now - Date.parse(it.published_at) < MAX_AGE_MS);
  const post = recent.slice(0, MAX_NEW_PER_POLL);
  const postIds = new Set(post.map((p) => p.guid));
  return { post, skip: fresh.filter((it) => !postIds.has(it.guid)) };
}

const BASE_INTERVAL_MS = 30 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Poll every 30 minutes; after failures back off (1h, 2h, 4h... up to a day) and retry quietly.
export function isDue(s: SourceState, now = Date.now()): boolean {
  if (!s.last_polled_at) return true;
  const wait = Math.min(BASE_INTERVAL_MS * 2 ** Math.min(s.failures, 10), MAX_INTERVAL_MS);
  return now - Date.parse(s.last_polled_at) >= wait;
}

// YouTube's channel feeds have returned intermittent 404s since December 2025; they are not a sign
// the channel has gone, so they are retried quietly rather than reported.
export function isQuietFailure(kind: SourceState['kind'], status: number): boolean {
  return kind === 'youtube' && (status === 404 || status === 500 || status === 503);
}

export function toPayload(kind: 'podcast' | 'youtube', source: { title: string; image_url: string | null }, it: FeedItem) {
  const base = {
    title: it.title,
    url: it.url,
    image: it.image || source.image_url,
    description: it.description,
    source_title: source.title,
    source_image: source.image_url,
    auto: true,
  };
  return kind === 'youtube'
    ? { postKind: 'video' as const, payload: { ...base, video_id: it.video_id } }
    : { postKind: 'podcast_episode' as const, payload: { ...base, audio_url: it.audio_url, duration_seconds: it.duration_seconds } };
}
