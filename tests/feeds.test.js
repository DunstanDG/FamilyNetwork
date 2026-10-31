import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  classifyLink, firstUrl, isPublicHttpUrl, safeImage, youtubeChannelRef, youtubeVideoId,
} from '../supabase/functions/_shared/links.js';
import { XML_OPTIONS, isDue, isQuietFailure, parseDuration, parseFeed, pickNew, toPayload } from '../supabase/functions/poll-feeds/logic.ts';
import { decodeEntities, extractChannelId, mapPodcastSearch, parseOpenGraph, podcastIndexHeaders } from '../supabase/functions/lookup/logic.ts';

const parse = (xml) => parseFeed(new XMLParser(XML_OPTIONS).parse(xml));

describe('links', () => {
  it('finds YouTube video ids in every usual shape, and nothing else', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) expect(youtubeVideoId(u), u).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(youtubeVideoId('javascript:alert(1)')).toBeNull();
  });
  it('reads channel links', () => {
    expect(youtubeChannelRef('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv')).toEqual({ channelId: 'UCabcdefghijklmnopqrstuv' });
    expect(youtubeChannelRef('https://youtube.com/@Some.Channel/videos')).toEqual({ handle: '@Some.Channel' });
    expect(youtubeChannelRef('https://www.youtube.com/c/Thing')).toEqual({ user: 'Thing', path: '/c/Thing' });
    expect(youtubeChannelRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });
  it('sorts shared links into videos, podcasts and news', () => {
    expect(classifyLink('https://youtu.be/dQw4w9WgXcQ')).toBe('video');
    expect(classifyLink('https://podcasts.apple.com/gb/podcast/x/id1?i=2')).toBe('podcast_episode');
    expect(classifyLink('https://open.spotify.com/episode/abc')).toBe('podcast_episode');
    expect(classifyLink('https://pca.st/episode/abc')).toBe('podcast_episode');
    expect(classifyLink('https://cdn.example/show/ep1.mp3')).toBe('podcast_episode');
    expect(classifyLink('https://open.spotify.com/track/abc')).toBe('link');
    expect(classifyLink('https://www.bbc.co.uk/news/articles/x')).toBe('link');
  });
  it('pulls the link out of shared text', () => {
    expect(firstUrl('Look at this! https://example.com/a/b. So good')).toBe('https://example.com/a/b');
    expect(firstUrl('nothing here')).toBeNull();
  });
  it('only lets the server fetch public addresses', () => {
    expect(isPublicHttpUrl('https://example.com/feed')).toBe(true);
    for (const u of [
      'http://localhost/x', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.20.0.1/', 'http://169.254.169.254/latest',
      'http://[::1]/', 'http://router/', 'http://nas.local/', 'https://example.com:8443/', 'ftp://example.com/', 'https://user:pw@example.com/', 'http://100.100.1.1/',
    ]) expect(isPublicHttpUrl(u), u).toBe(false);
  });
  it('shows https images only', () => {
    expect(safeImage('https://img.example/a.jpg')).toBe('https://img.example/a.jpg');
    expect(safeImage('http://img.example/a.jpg')).toBeNull();
    expect(safeImage('data:image/png;base64,xx')).toBeNull();
  });
});

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Garden Hour</title><link>https://garden.example/</link>
  <itunes:image href="https://garden.example/art.jpg"/>
  <item>
    <title>Older &amp; wiser</title><guid isPermaLink="false">ep-1</guid>
    <pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example/ep1.mp3" type="audio/mpeg" length="1"/>
    <itunes:duration>1:02:03</itunes:duration>
    <description><![CDATA[<p>All about <b>roses</b></p>]]></description>
  </item>
  <item>
    <title>Newest</title><guid>ep-2</guid>
    <pubDate>Fri, 30 Oct 2026 08:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example/ep2.mp3" type="audio/mpeg"/>
    <itunes:duration>1800</itunes:duration>
    <itunes:image href="https://garden.example/ep2.jpg"/>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
  <title>Woodwork Weekly</title>
  <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
  <entry>
    <id>yt:video:dQw4w9WgXcQ</id><yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <title>Making a chair</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <published>2026-10-30T10:00:00+00:00</published>
    <media:group>
      <media:title>Making a chair</media:title>
      <media:thumbnail url="https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
      <media:description>Step by step</media:description>
    </media:group>
  </entry>
</feed>`;

describe('feed parsing', () => {
  it('reads podcast RSS newest first, with audio, duration, artwork and plain-text notes', () => {
    const f = parse(RSS);
    expect(f.title).toBe('Garden Hour');
    expect(f.image).toBe('https://garden.example/art.jpg');
    expect(f.items.map((i) => i.guid)).toEqual(['ep-2', 'ep-1']);
    const [newest, older] = f.items;
    expect(newest).toMatchObject({ audio_url: 'https://cdn.example/ep2.mp3', duration_seconds: 1800, image: 'https://garden.example/ep2.jpg' });
    expect(older).toMatchObject({ title: 'Older & wiser', duration_seconds: 3723, image: 'https://garden.example/art.jpg', description: 'All about roses' });
    expect(older.published_at).toBe('2026-10-26T08:00:00.000Z');
  });
  it('reads YouTube Atom feeds', () => {
    const f = parse(ATOM);
    expect(f.title).toBe('Woodwork Weekly');
    expect(f.items[0]).toMatchObject({
      guid: 'yt:video:dQw4w9WgXcQ', video_id: 'dQw4w9WgXcQ', title: 'Making a chair', description: 'Step by step',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', image: 'https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
  });
  it('refuses things that are not feeds', () => {
    expect(() => parse('<html><body>hi</body></html>')).toThrow();
  });
  it('reads durations', () => {
    expect(parseDuration('45:10')).toBe(2710);
    expect(parseDuration('3723.4')).toBe(3723);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
  });
});

describe('choosing what to post', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const item = (guid, daysAgo) => ({ guid, published_at: new Date(now - daysAgo * 864e5).toISOString() });
  const items = [item('a', 0), item('b', 1), item('c', 2), item('old', 40)];

  it('posts only the latest episode when a show is first followed', () => {
    const r = pickNew(items, new Set(), true, now);
    expect(r.post.map((i) => i.guid)).toEqual(['a']);
    expect(r.skip.map((i) => i.guid)).toEqual(['b', 'c', 'old']);
  });
  it('then posts what is new and recent, skipping what is seen or stale', () => {
    const r = pickNew(items, new Set(['b']), false, now);
    expect(r.post.map((i) => i.guid)).toEqual(['a', 'c']);
    expect(r.skip.map((i) => i.guid)).toEqual(['old']);
  });
  it('caps a burst of new items', () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`n${i}`, 0));
    const r = pickNew(many, new Set(), false, now);
    expect(r.post).toHaveLength(5);
    expect(r.skip).toHaveLength(7);
  });
  it('polls every half hour and backs off after failures', () => {
    const at = (min) => new Date(now - min * 60000).toISOString();
    expect(isDue({ last_polled_at: null, failures: 0 }, now)).toBe(true);
    expect(isDue({ last_polled_at: at(20), failures: 0 }, now)).toBe(false);
    expect(isDue({ last_polled_at: at(31), failures: 0 }, now)).toBe(true);
    expect(isDue({ last_polled_at: at(90), failures: 2 }, now)).toBe(false);
    expect(isDue({ last_polled_at: at(60 * 25), failures: 9 }, now)).toBe(true);
  });
  it('retries YouTube 404s quietly but reports podcast ones', () => {
    expect(isQuietFailure('youtube', 404)).toBe(true);
    expect(isQuietFailure('podcast', 404)).toBe(false);
  });
  it('shapes posts for each kind', () => {
    const src = { title: 'Show', image_url: 'https://x.example/art.jpg' };
    const ep = { guid: 'g', title: 'T', url: null, audio_url: 'https://x.example/a.mp3', duration_seconds: 60, image: null, video_id: null, description: '' };
    expect(toPayload('podcast', src, ep)).toMatchObject({ postKind: 'podcast_episode', payload: { audio_url: 'https://x.example/a.mp3', image: 'https://x.example/art.jpg', source_title: 'Show', auto: true } });
    expect(toPayload('youtube', src, { ...ep, video_id: 'dQw4w9WgXcQ' })).toMatchObject({ postKind: 'video', payload: { video_id: 'dQw4w9WgXcQ' } });
  });
});

describe('link previews', () => {
  it('reads Open Graph tags, resolving relative images and decoding entities', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Big news &amp; more">
      <meta content="A summary" property="og:description">
      <meta property="og:image" content="/img/hero.jpg">
      <meta property="og:site_name" content="The Paper"></head></html>`;
    expect(parseOpenGraph(html, 'https://paper.example/story')).toEqual({
      title: 'Big news & more', description: 'A summary', image: 'https://paper.example/img/hero.jpg', site: 'The Paper', audio_url: null,
    });
  });
  it('falls back to the title tag and host, and drops insecure images', () => {
    const p = parseOpenGraph('<title>Just a page</title><meta name="twitter:image" content="http://x.example/a.jpg">', 'https://www.site.example/');
    expect(p).toMatchObject({ title: 'Just a page', site: 'site.example', image: null });
  });
  it('decodes numeric entities', () => {
    expect(decodeEntities('It&#39;s &#x2014; ok &bogus;')).toBe("It's — ok &bogus;");
  });
  it('finds a channel id on a channel page', () => {
    expect(extractChannelId('<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">')).toBe('UCabcdefghijklmnopqrstuv');
    expect(extractChannelId('..."externalId":"UCabcdefghijklmnopqrstuv"...')).toBe('UCabcdefghijklmnopqrstuv');
    expect(extractChannelId('<html></html>')).toBeNull();
  });
  it('signs Podcast Index requests', async () => {
    const h = await podcastIndexHeaders('KEY', 'SECRET', 1_700_000_000_000);
    expect(h['X-Auth-Date']).toBe('1700000000');
    expect(h.Authorization).toMatch(/^[0-9a-f]{40}$/);
    // sha1("KEYSECRET1700000000")
    const { createHash } = await import('node:crypto');
    expect(h.Authorization).toBe(createHash('sha1').update('KEYSECRET1700000000').digest('hex'));
  });
  it('tidies Podcast Index results', () => {
    const shows = mapPodcastSearch({ feeds: [
      { title: 'A', author: 'Ann', artwork: 'https://a.example/a.jpg', url: 'https://a.example/rss', link: 'https://a.example' },
      { title: 'A again', url: 'https://a.example/rss' },
      { title: 'Dead', url: 'https://d.example/rss', dead: 1 },
      { title: 'Bad', url: 'javascript:1' },
    ] });
    expect(shows).toEqual([{ title: 'A', author: 'Ann', image: 'https://a.example/a.jpg', feed_url: 'https://a.example/rss', site_url: 'https://a.example' }]);
    expect(mapPodcastSearch(null)).toEqual([]);
  });
});
