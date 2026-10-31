export const REACTIONS = [
  { key: 'heart', emoji: '❤️', label: 'Love' },
  { key: 'laugh', emoji: '😂', label: 'Funny' },
  { key: 'wow', emoji: '😮', label: 'Wow' },
  { key: 'thumbs_up', emoji: '👍', label: 'Like' },
];

// The tabs, and the post kind each one shows. Home shows everything.
export const MODULES = [
  { id: 'home', label: 'Home', icon: '🏠', kind: null },
  { id: 'photos', label: 'Photos', icon: '📷', kind: 'photo_album', phase: 3, when: 'mid-March' },
  { id: 'podcasts', label: 'Podcasts', icon: '🎧', kind: 'podcast_episode', phase: 2, when: 'January' },
  { id: 'videos', label: 'Videos', icon: '▶️', kind: 'video', phase: 2, when: 'January' },
  { id: 'news', label: 'News', icon: '📰', kind: 'link', phase: 2, when: 'January' },
  { id: 'calendar', label: 'Calendar', icon: '📅', kind: 'event', phase: 4, when: 'April' },
];

export const KIND_LABEL = {
  update: 'Updates',
  photo_album: 'Photos',
  podcast_episode: 'Podcasts',
  video: 'Videos',
  link: 'News',
  event: 'Calendar',
};

export function summariseReactions(rows = [], myId) {
  return REACTIONS.map((r) => {
    const mine = rows.filter((x) => x.emoji === r.key);
    return { ...r, count: mine.length, mine: mine.some((x) => x.user_id === myId) };
  });
}

// Where to draw the "since you last looked" line. `posts` is newest first (pinned posts are
// skipped: they sit at the top whatever their age). The line goes above the first post you had
// already seen, and only appears if someone else has posted since.
export function findUnreadDivider(posts, since, myId) {
  if (!since) return null;
  const cutoff = new Date(since).getTime();
  let count = 0;
  let index = posts.length;
  for (let i = 0; i < posts.length; i += 1) {
    const p = posts[i];
    if (p.pinned) continue;
    if (new Date(p.created_at).getTime() > cutoff) {
      if (p.author_id !== myId) count += 1;
    } else {
      index = i;
      break;
    }
  }
  return count > 0 ? { index, count } : null;
}

// Combine a refreshed first page with posts already loaded further down.
export function mergePosts(fresh, existing) {
  const seen = new Set(fresh.map((p) => p.id));
  const oldest = fresh.length ? fresh[fresh.length - 1].created_at : null;
  const rest = existing.filter((p) => !seen.has(p.id) && !p._pending && (oldest ? p.created_at < oldest : false));
  return [...fresh, ...rest];
}

export function sortPosts(posts) {
  return [...posts].sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });
}

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';

// A stable, gentle colour per person for the avatar fallback.
export function avatarHue(id = '') {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function normaliseLink(input) {
  const raw = (input || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
