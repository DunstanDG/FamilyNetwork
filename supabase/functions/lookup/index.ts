// Things the app can't do from the browser (other sites block cross-origin requests, and the Podcast
// Index key must stay secret). Only family members may call it.
//
//   POST { action: 'preview', url }          -> { title, description, image, site, audio_url, video_id? }
//   POST { action: 'youtube-channel', url }  -> { channel_id, feed_url, title, image }
//   POST { action: 'podcast-feed', url }     -> { feed_url, title, image, site_url }
//   POST { action: 'podcast-search', q }     -> { shows: [...] }
//
// Deploy with:  supabase functions deploy lookup
// Secrets: PODCAST_INDEX_KEY, PODCAST_INDEX_SECRET (free from https://api.podcastindex.org)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';
import { isAudioUrl, youtubeChannelRef, youtubeFeedUrl, youtubeVideoId, safeImage } from '../_shared/links.js';
import { XML_OPTIONS, parseFeed } from '../poll-feeds/logic.ts';
import { readCapped, safeFetch } from '../_shared/safeFetch.js';
import { extractChannelId, mapPodcastSearch, parseOpenGraph, podcastIndexHeaders } from './logic.ts';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

const UA = 'Mozilla/5.0 (compatible; FamilyNetwork/1.0; +private family app)';
const MAX_BYTES = 1024 * 1024;

async function fetchText(url: string, accept = 'text/html,application/xhtml+xml'): Promise<{ text: string; type: string; finalUrl: string }> {
  // Checks the address, every redirect hop, and what the name resolves to.
  const res = await safeFetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en-GB,en;q=0.8' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) { res.body?.cancel(); throw new Error(`The site answered ${res.status}.`); }
  const type = res.headers.get('content-type') || '';
  if (/^(audio|video|image)\//i.test(type)) { res.body?.cancel(); return { text: '', type, finalUrl: res.finalUrl }; }
  return { text: await readCapped(res, MAX_BYTES), type, finalUrl: res.finalUrl };
}

async function preview(url: string) {
  const videoId = youtubeVideoId(url);
  if (videoId) {
    const o = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { signal: AbortSignal.timeout(8000) });
    const j = o.ok ? await o.json() : {};
    return {
      title: j.title ?? null, description: null, site: j.author_name ?? 'YouTube',
      image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, audio_url: null, video_id: videoId,
    };
  }
  const page = await fetchText(url);
  if (/^audio\//i.test(page.type) || isAudioUrl(url)) {
    return { title: null, description: null, image: null, site: new URL(url).hostname.replace(/^www\./, ''), audio_url: url };
  }
  return parseOpenGraph(page.text, page.finalUrl);
}

async function youtubeChannel(url: string) {
  const ref = youtubeChannelRef(url);
  if (!ref) throw new Error('That doesn’t look like a YouTube channel link.');
  let channelId = ref.channelId as string | undefined;
  let title: string | null = null;
  let image: string | null = null;
  if (!channelId) {
    const path = ref.handle ? `/${ref.handle}` : ref.path;
    const page = await fetchText(`https://www.youtube.com${path}`);
    channelId = extractChannelId(page.text) ?? undefined;
    const og = parseOpenGraph(page.text, page.finalUrl);
    title = og.title; image = og.image;
  }
  if (!channelId) throw new Error('Couldn’t find that channel.');
  const feedUrl = youtubeFeedUrl(channelId);
  if (!title) {
    try {
      const feed = parseFeed(new XMLParser(XML_OPTIONS).parse((await fetchText(feedUrl, 'application/atom+xml')).text));
      title = feed.title;
    } catch { /* the feed can 404 intermittently; the title is filled in by the poller */ }
  }
  return { channel_id: channelId, feed_url: feedUrl, title: title || 'YouTube channel', image: safeImage(image) };
}

async function podcastFeed(url: string) {
  const page = await fetchText(url, 'application/rss+xml, application/xml, text/xml');
  const feed = parseFeed(new XMLParser(XML_OPTIONS).parse(page.text));
  if (!feed.items.some((i) => i.audio_url)) throw new Error('That feed has no episodes to play.');
  return { feed_url: url, title: feed.title || 'Podcast', image: feed.image, site_url: feed.link };
}

async function podcastSearch(q: string) {
  const key = Deno.env.get('PODCAST_INDEX_KEY');
  const secret = Deno.env.get('PODCAST_INDEX_SECRET');
  if (!key || !secret) throw new Error('Podcast search isn’t set up yet. You can paste a show’s RSS link instead.');
  const res = await fetch(`https://api.podcastindex.org/api/1.0/search/byterm?max=15&q=${encodeURIComponent(q)}`, {
    headers: await podcastIndexHeaders(key, secret), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('Podcast search is not answering. Try again later.');
  return { shows: mapPodcastSearch(await res.json()) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    db: { schema: 'family' }, global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: member } = await db.rpc('is_member');
  if (member !== true) return reply({ error: 'Family members only.' }, 403);

  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'preview': return reply(await preview(String(body.url || '')));
      case 'youtube-channel': return reply(await youtubeChannel(String(body.url || '')));
      case 'podcast-feed': return reply(await podcastFeed(String(body.url || '')));
      case 'podcast-search': {
        const q = String(body.q || '').trim().slice(0, 100);
        return q ? reply(await podcastSearch(q)) : reply({ shows: [] });
      }
      default: return reply({ error: 'Unknown action' }, 400);
    }
  } catch (e) {
    return reply({ error: e?.message ?? 'Lookup failed' }, 422);
  }
});
