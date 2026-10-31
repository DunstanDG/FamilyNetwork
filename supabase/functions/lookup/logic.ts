// Pure helpers for the lookup function: link previews, YouTube channel ids, Podcast Index search.
import { safeImage } from '../_shared/links.js';

export interface Preview {
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
  audio_url: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string | null | undefined, max: number): string | null => {
  if (!s) return null;
  const t = decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

function resolve(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  try { return new URL(decodeEntities(raw), base).toString(); } catch { return null; }
}

// Reads Open Graph / Twitter card / plain HTML tags from the start of a page.
export function parseOpenGraph(html: string, pageUrl: string): Preview {
  const head = html.slice(0, 400_000);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const host = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return null; } })();
  const audio = resolve(meta['og:audio'] || meta['og:audio:url'] || meta['og:audio:secure_url'], pageUrl);
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag, 200),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description, 300),
    image: safeImage(resolve(meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'], pageUrl)),
    site: clean(meta['og:site_name'], 80) || host,
    audio_url: audio && /^https?:/.test(audio) ? audio : null,
  };
}

// A channel page names its own id in several places; any one will do.
export function extractChannelId(html: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i,
    /<meta[^>]+itemprop=["'](?:identifier|channelId)["'][^>]+content=["'](UC[A-Za-z0-9_-]{22})/i,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Podcast Index signs each request with sha1(key + secret + unix time).
export async function podcastIndexHeaders(key: string, secret: string, now = Date.now()) {
  const date = String(Math.floor(now / 1000));
  return {
    'User-Agent': 'FamilyNetwork/1.0',
    'X-Auth-Date': date,
    'X-Auth-Key': key,
    Authorization: await sha1Hex(key + secret + date),
  };
}

export interface Show { title: string; author: string | null; image: string | null; feed_url: string; site_url: string | null }

export function mapPodcastSearch(json: unknown): Show[] {
  const feeds = (json as { feeds?: unknown[] })?.feeds;
  if (!Array.isArray(feeds)) return [];
  const seen = new Set<string>();
  const out: Show[] = [];
  for (const f of feeds as Record<string, unknown>[]) {
    const url = String(f.url || '');
    if (!/^https?:\/\//.test(url) || seen.has(url) || f.dead) continue;
    seen.add(url);
    out.push({
      title: clean(String(f.title || ''), 200) || 'Untitled show',
      author: clean(String(f.author || f.ownerName || ''), 120),
      image: safeImage(String(f.artwork || f.image || '')),
      feed_url: url,
      site_url: /^https?:\/\//.test(String(f.link || '')) ? String(f.link) : null,
    });
  }
  return out.slice(0, 12);
}
