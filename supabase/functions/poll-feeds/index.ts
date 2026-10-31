// Polls every followed podcast and YouTube channel and files new episodes and videos under today's
// "New from your shows" digest.
//
// Called every 15 minutes by pg_cron (see supabase/schedule.sql) with an `x-cron-secret` header.
// Deploy with:  supabase functions deploy poll-feeds --no-verify-jwt
// Secrets: CRON_SECRET (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';
import { isPublicHttpUrl } from '../_shared/links.js';
import { safeEqual } from '../send-push/logic.ts';
import { XML_OPTIONS, isDue, isQuietFailure, parseFeed, pickNew, toPayload } from './logic.ts';

const secret = Deno.env.get('CRON_SECRET') ?? '';
const MAX_BYTES = 5 * 1024 * 1024;
const parser = new XMLParser(XML_OPTIONS);

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { reader.cancel(); throw new Error('feed is too large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

Deno.serve(async (req) => {
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) {
    return new Response('Forbidden', { status: 403 });
  }
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    db: { schema: 'family' },
    auth: { persistSession: false },
  });

  const { data: sources, error } = await db.from('sources')
    .select('id, kind, feed_url, title, image_url, etag, last_modified, last_polled_at, failures');
  if (error) return new Response(error.message, { status: 500 });

  const report: string[] = [];
  for (const s of (sources ?? []).filter((x) => isDue(x))) {
    const now = new Date().toISOString();
    try {
      if (!isPublicHttpUrl(s.feed_url)) throw new Error('feed address is not allowed');
      const headers: Record<string, string> = { 'user-agent': 'FamilyNetwork/1.0 (+private family app)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
      if (s.etag) headers['if-none-match'] = s.etag;
      if (s.last_modified) headers['if-modified-since'] = s.last_modified;
      const res = await fetch(s.feed_url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });

      if (res.status === 304) {
        await db.from('sources').update({ last_polled_at: now, failures: 0, last_error: null }).eq('id', s.id);
        report.push(`${s.title}: unchanged`);
        continue;
      }
      if (!res.ok) {
        const quiet = isQuietFailure(s.kind, res.status);
        await db.from('sources').update({
          last_polled_at: now, failures: s.failures + 1, last_error: quiet ? s.last_error : `HTTP ${res.status}`,
        }).eq('id', s.id);
        if (!quiet) report.push(`${s.title}: HTTP ${res.status}`);
        continue;
      }

      const feed = parseFeed(parser.parse(await readCapped(res)));
      const { data: seenRows } = await db.from('feed_items').select('guid').eq('source_id', s.id);
      const seen = new Set((seenRows ?? []).map((r) => r.guid));
      const { post, skip } = pickNew(feed.items, seen, !s.last_polled_at && seen.size === 0);

      const source = { title: s.title || feed.title, image_url: s.image_url || feed.image };
      // Oldest first, so the digest lists them in the order they came out.
      for (const it of [...post].reverse()) {
        const { postKind, payload } = toPayload(s.kind, source, it);
        await db.rpc('add_feed_item', { p_source: s.id, p_guid: it.guid, p_kind: postKind, p_payload: payload, p_post: true, p_published: it.published_at });
      }
      if (skip.length) {
        // Back catalogue and stragglers: remember them so they are never posted later.
        await db.from('feed_items')
          .upsert(skip.map((it) => ({ source_id: s.id, guid: it.guid })), { onConflict: 'source_id,guid', ignoreDuplicates: true });
      }

      await db.from('sources').update({
        last_polled_at: now, failures: 0, last_error: null,
        etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified'),
        title: s.title || feed.title || '', image_url: s.image_url || feed.image,
      }).eq('id', s.id);
      report.push(`${s.title || feed.title}: ${post.length} new`);
    } catch (e) {
      await db.from('sources').update({ last_polled_at: now, failures: s.failures + 1, last_error: String(e?.message ?? e).slice(0, 300) }).eq('id', s.id);
      report.push(`${s.title}: ${e?.message ?? e}`);
    }
  }
  return new Response(report.join('\n') || 'Nothing due');
});
