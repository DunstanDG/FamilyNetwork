// Link rules shared by the app (imported by Vite) and the Edge Functions (imported by Deno).
// Plain JavaScript with no imports, so both can load it as is.

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function parse(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// The 11-character id of a YouTube video, from any of the usual link shapes, or null.
export function youtubeVideoId(url) {
  const u = parse(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (YT_HOSTS.has(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

// What a YouTube channel link points at: { channelId } when it is in the link, otherwise
// { handle } or { user } (which need looking up), or null if it is not a channel link.
export function youtubeChannelRef(url) {
  const u = parse(url);
  if (!u || !YT_HOSTS.has(u.hostname.toLowerCase())) return null;
  const feedId = u.pathname === '/feeds/videos.xml' ? u.searchParams.get('channel_id') : null;
  if (feedId && CHANNEL_ID.test(feedId)) return { channelId: feedId };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'channel' && CHANNEL_ID.test(parts[1] || '')) return { channelId: parts[1] };
  if (parts[0]?.startsWith('@') && parts[0].length > 1) return { handle: decodeURIComponent(parts[0]) };
  if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) return { user: parts[1], path: `/${parts[0]}/${parts[1]}` };
  return null;
}

export const isChannelId = (id) => CHANNEL_ID.test(id || '');
export const youtubeFeedUrl = (channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
export const youtubeThumb = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
export const youtubeEmbed = (videoId, start = 0) =>
  `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1${start ? `&start=${Math.floor(start)}` : ''}`;

const PODCAST_HOSTS = [
  'podcasts.apple.com', 'open.spotify.com/episode', 'open.spotify.com/show', 'pca.st', 'pocketcasts.com',
  'overcast.fm', 'castbox.fm', 'castro.fm', 'pod.link', 'podcastaddict.com', 'player.fm', 'podbean.com',
  'bbc.co.uk/sounds', 'music.amazon.co.uk/podcasts', 'music.amazon.com/podcasts', 'goodpods.com', 'podcastindex.org',
];
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav)$/i;

export function isAudioUrl(url) {
  const u = parse(url);
  return Boolean(u && AUDIO_EXT.test(u.pathname));
}

export function isPodcastLink(url) {
  const u = parse(url);
  if (!u) return false;
  const hostPath = `${u.hostname.replace(/^www\./, '')}${u.pathname}`.toLowerCase();
  return isAudioUrl(url) || PODCAST_HOSTS.some((h) => hostPath === h || hostPath.startsWith(`${h}/`));
}

// Which kind of post a shared link becomes.
export function classifyLink(url) {
  if (youtubeVideoId(url)) return 'video';
  if (isPodcastLink(url)) return 'podcast_episode';
  return 'link';
}

// The first web link in some shared text (Android often puts the link in "text", not "url").
export function firstUrl(text) {
  const m = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/i.exec(String(text || ''));
  return m ? m[0] : null;
}

// Only https images are shown, so a post can never pull in an insecure or odd-scheme address.
export function safeImage(url) {
  const u = parse(url);
  return u && u.protocol === 'https:' ? u.toString() : null;
}

// Guard for anything the server fetches on someone's behalf: public http(s) addresses only, never
// the machine itself or a private network.
export function isPublicHttpUrl(url) {
  const u = parse(url);
  if (!u || u.username || u.password) return false;
  if (u.port && !['80', '443'].includes(u.port)) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) return false;
  }
  return true;
}
