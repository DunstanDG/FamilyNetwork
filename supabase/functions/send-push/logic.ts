// Pure decisions for the push sender, kept free of Deno APIs so they can be unit tested.

export interface Notification {
  kind: 'mention' | 'reply' | 'album' | 'vote' | 'event';
  module: string; // the kind of post it relates to: update, photo_album, ...
  post_id: string | null;
  snippet: string | null;
}

const TITLES: Record<Notification['kind'], (who: string) => string> = {
  mention: (who) => `${who} mentioned you`,
  reply: (who) => `${who} replied to you`,
  album: (who) => `${who} shared new photos`,
  vote: (who) => `${who} wants your vote`,
  event: (who) => `${who} updated an event`,
};

export function isMuted(mutedKinds: string[] | null | undefined, module: string): boolean {
  return Array.isArray(mutedKinds) && mutedKinds.includes(module);
}

export function buildPayload(n: Notification, actorName: string | null | undefined) {
  const who = (actorName || 'Someone').slice(0, 40);
  const title = (TITLES[n.kind] ?? (() => `${who} did something`))(who);
  return {
    title,
    body: (n.snippet || '').slice(0, 140),
    postId: n.post_id,
    tag: n.post_id ? `post-${n.post_id}` : undefined,
  };
}

// Compare secrets without leaking, through timing, how much of a guess was right.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
