// Open YouTube search with a verdict on every channel. Only family members may call it.
//
//   POST { action: 'search', q }  -> { results: [{ video_id, title, channel_id, channel_title,
//                                       published_at, duration_seconds, synthetic, tier, reason }],
//                                      hidden, cached }
//
// Results go back at once. Channels nobody has seen before come back as tier 'checking'; they are
// looked up and judged after the response has gone (quick rules, then one Gemini call for the lot),
// and each verdict is written to family.yt_channels, which the app is listening to.
//
// Deploy with:  supabase functions deploy yt-search
// Secrets: YOUTUBE_API_KEY (YouTube Data API v3), GEMINI_API_KEY,
//          GEMINI_MODEL (optional; a Flash model is plenty),
//          YT_DAILY_SEARCHES (optional, default 90: uncached searches a day, 100 quota units each),
//          YT_LOG_SEARCHES (optional; 'true' also records what people searched for)
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  RESPONSE_SCHEMA, SYSTEM_PROMPT, assemble, buildPrompt, decide, followedChannelId, mapChannels, mapUploadTitles,
  mapVideos, needsCheck, normaliseQuery, parseModelVerdicts, ruleFlag,
  type ChannelFacts, type VerdictRow, type Video,
} from './logic.ts';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

const YT = 'https://www.googleapis.com/youtube/v3';
const CACHE_HOURS = 24;
const MAX_RESULTS = 20;

const env = (name: string) => Deno.env.get(name) ?? '';

async function youtube(path: string, params: Record<string, string>) {
  const res = await fetch(`${YT}/${path}?${new URLSearchParams(params)}`, {
    headers: { 'x-goog-api-key': env('YOUTUBE_API_KEY'), accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`youtube ${path} ${res.status}: ${detail.slice(0, 300)}`);
    throw new Error(res.status === 403 ? 'YouTube isn’t taking any more searches today. Try again tomorrow.' : 'YouTube isn’t answering. Try again in a moment.');
  }
  return res.json();
}

// One search (100 quota units) and one details call (1 unit).
async function searchYouTube(q: string): Promise<Video[]> {
  const search = await youtube('search', {
    part: 'snippet', type: 'video', q, maxResults: String(MAX_RESULTS), safeSearch: 'strict',
    videoEmbeddable: 'true', regionCode: 'GB', relevanceLanguage: 'en',
  });
  const ids = (search.items ?? []).map((i: any) => i?.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await youtube('videos', { part: 'contentDetails,status', id: ids.join(','), maxResults: '50' });
  return mapVideos(search, details);
}

async function askGemini(prompt: string): Promise<string> {
  const model = env('GEMINI_MODEL') || 'gemini-3.6-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const json = await res.json();
  return (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
}

// After the response has gone: look the channels up, judge them, write the verdicts.
async function classify(svc: any, ids: string[], videos: Video[]) {
  const flags = new Map<string, string>();
  try {
    const facts: ChannelFacts[] = mapChannels(await youtube('channels', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: '50' }));
    // The last few uploads say more about a channel than its description (1 unit each; failures are fine).
    await Promise.all(facts.map(async (c) => {
      if (!c.uploads) return;
      try { c.recent_titles = mapUploadTitles(await youtube('playlistItems', { part: 'snippet', playlistId: c.uploads, maxResults: '10' })); } catch { /* judge without them */ }
    }));
    for (const c of facts) flags.set(c.channel_id, ruleFlag(c));
    // What the rules know goes out first, so a "new channel" warning doesn't wait for the model.
    await Promise.all(facts.filter((c) => flags.get(c.channel_id)).map((c) =>
      svc.from('yt_channels').update({ reason: flags.get(c.channel_id) }).eq('channel_id', c.channel_id).eq('tier', 'checking')));

    const searchTitles = new Map<string, string[]>();
    for (const v of videos) searchTitles.set(v.channel_id, [...(searchTitles.get(v.channel_id) ?? []), v.title]);
    const verdicts = facts.length ? parseModelVerdicts(await askGemini(buildPrompt(facts, searchTitles)), ids) : new Map();

    await Promise.all(ids.map(async (id) => {
      const v = decide(verdicts.get(id), flags.get(id) ?? '');
      const { error } = await svc.from('yt_channels').update({
        tier: v.tier, reason: v.reason, topic: v.topic, confidence: v.confidence, note: v.note, source: v.source,
        checked_at: new Date().toISOString(),
      }).eq('channel_id', id);
      if (error) console.error(`verdict ${id}: ${error.message}`);
      if (v.review) {
        // One open item per channel is enough: a duplicate (23505) just means it is already waiting.
        const { error: queued } = await svc.from('yt_reviews').insert({ channel_id: id, why: 'unsure' });
        if (queued && queued.code !== '23505') console.error(`review ${id}: ${queued.message}`);
      }
    }));
  } catch (e) {
    console.error(`classify failed: ${e?.message ?? e}`);
    // Not a verdict: the app shows "Not yet checked", and the next search tries again.
    await Promise.all(ids.map((id) =>
      svc.from('yt_channels').update({ tier: 'unchecked', reason: flags.get(id) ?? '', source: 'rules' }).eq('channel_id', id).eq('tier', 'checking')));
  }
}

async function search(svc: any, userId: string | null, rawQuery: unknown) {
  const q = normaliseQuery(rawQuery);
  if (!q) return reply({ results: [], hidden: 0, cached: false });

  let cached = true;
  let videos: Video[];
  const hit = await svc.from('yt_search_cache').select('results').eq('query_key', q).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (hit.data) {
    videos = hit.data.results as Video[];
  } else {
    cached = false;
    const cap = Number(env('YT_DAILY_SEARCHES')) || 90;
    const { data: allowed, error } = await svc.rpc('yt_take_quota', { p_cap: cap });
    if (error) throw new Error(error.message);
    if (allowed !== true) return reply({ error: 'The family has used today’s searches. They come back tomorrow morning.' }, 429);
    videos = await searchYouTube(q);
    await svc.from('yt_search_cache').upsert({
      query_key: q, results: videos, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + CACHE_HOURS * 3600_000).toISOString(),
    });
  }

  if (userId && env('YT_LOG_SEARCHES') === 'true') {
    await svc.from('yt_activity').insert({ user_id: userId, kind: 'search', query: q });
  }

  const ids = [...new Set(videos.map((v) => v.channel_id))];
  if (!ids.length) return reply({ results: [], hidden: 0, cached });

  const [{ data: known }, { data: sources }] = await Promise.all([
    svc.from('yt_channels').select('channel_id, tier, reason, topic, confidence, source, updated_at').in('channel_id', ids),
    svc.from('sources').select('feed_url').eq('kind', 'youtube'),
  ]);
  const rows = new Map<string, VerdictRow>((known ?? []).map((r: VerdictRow) => [r.channel_id, r]));
  const followed = new Set((sources ?? []).map((s: { feed_url: string }) => followedChannelId(s.feed_url)).filter(Boolean));

  // Channels the family chose to follow are trusted without asking anyone (an admin can still overrule).
  const now = new Date().toISOString();
  const titles = new Map(videos.map((v) => [v.channel_id, v.channel_title]));
  const trust = ids.filter((id) => followed.has(id) && rows.get(id)?.source !== 'admin' && rows.get(id)?.tier !== 'trusted');
  const pending = ids.filter((id) => !followed.has(id) && needsCheck(rows.get(id)));

  if (trust.length) {
    const fresh = trust.map((id) => ({ channel_id: id, title: titles.get(id) || null, title_at: now, tier: 'trusted', reason: 'followed', source: 'rules', checked_at: now }));
    await svc.from('yt_channels').upsert(fresh);
    for (const r of fresh) rows.set(r.channel_id, r as VerdictRow);
  }
  if (pending.length) {
    await svc.from('yt_channels').upsert(pending.map((id) => ({ channel_id: id, title: titles.get(id) || null, title_at: now, tier: 'checking', reason: '', source: 'pending' })));
    // @ts-ignore: provided by the Supabase Edge runtime; keeps the function alive after the response.
    EdgeRuntime.waitUntil(classify(svc, pending, videos));
  }
  // Names come from YouTube and may only be kept 30 days; seeing a channel again renews its name.
  const renew = ids.filter((id) => !trust.includes(id) && !pending.includes(id) && titles.get(id));
  if (!cached && renew.length) {
    await Promise.all(renew.map((id) => svc.from('yt_channels').update({ title: titles.get(id), title_at: now }).eq('channel_id', id)));
  }

  return reply({ ...assemble(videos, [...rows.values()], new Set(pending)), cached });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    db: { schema: 'family' }, global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: member } = await db.rpc('is_member');
  if (member !== true) return reply({ error: 'Family members only.' }, 403);
  if (!env('YOUTUBE_API_KEY') || !env('GEMINI_API_KEY')) return reply({ error: 'Video search isn’t set up yet (see the README).' }, 503);

  const svc = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { db: { schema: 'family' }, auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action !== 'search') return reply({ error: 'Unknown action' }, 400);
    const { data: who } = env('YT_LOG_SEARCHES') === 'true' ? await db.auth.getUser(auth.replace(/^Bearer\s+/i, '')) : { data: null };
    return await search(svc, who?.user?.id ?? null, body.q);
  } catch (e) {
    return reply({ error: e?.message ?? 'Search failed' }, 422);
  }
});
