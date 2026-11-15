// What the app says about a channel's verdict. The codes come from the yt-search function and
// family.yt_channels; the words live here so they can be read (and tested) in one place.

// How long a card says "Checking…" before giving up and saying so.
export const CHECK_TIMEOUT_MS = 20_000;

const CAUTION = {
  new_channel: 'New channel, little track record',
  small_channel: 'Small channel, little track record',
  conspiracy: 'May promote conspiracy theories',
  misleading: 'May make claims without good sources',
  ai_generated: 'Likely AI-generated',
  clickbait: 'Sensational or clickbait style',
  low_quality: 'Low-quality or reposted content',
  unsure: 'Couldn’t tell much about this channel',
  admin: 'Marked “take care” by a family admin',
};

const BLOCKED = {
  conspiracy: 'promotes conspiracy theories',
  misleading: 'makes misleading claims',
  ai_generated: 'likely AI-generated',
  admin: 'blocked by a family admin',
};

const TRUSTED = {
  followed: 'A channel the family follows',
  admin: 'Approved by a family admin',
};

// tone: ok (quiet tick), warn (amber label), wait (still checking), none (no verdict), gone (hidden).
export function describeVerdict({ tier, reason = '' } = {}, waitedMs = 0) {
  switch (tier) {
    case 'trusted': return { tone: 'ok', label: TRUSTED[reason] || 'Checked' };
    case 'caution': return { tone: 'warn', label: CAUTION[reason] || 'Take care with this channel' };
    case 'blocked': return { tone: 'gone', label: `Removed: ${BLOCKED[reason] || 'not suitable'}` };
    case 'checking':
      if (waitedMs < CHECK_TIMEOUT_MS) return { tone: 'wait', label: CAUTION[reason] ? `Checking… ${CAUTION[reason]}` : 'Checking…' };
      return { tone: 'none', label: CAUTION[reason] ? `Not yet checked. ${CAUTION[reason]}` : 'Not yet checked' };
    default: return { tone: 'none', label: CAUTION[reason] ? `Not yet checked. ${CAUTION[reason]}` : 'Not yet checked' };
  }
}

export const SYNTHETIC_LABEL = 'The uploader says this is AI-made or altered';

// The newest verdict for each channel on screen: what the search returned, overlaid with anything
// that has arrived since. Order never changes, so nothing moves under a thumb.
export function withVerdicts(results, verdicts) {
  return results.map((r) => {
    const v = verdicts[r.channel_id];
    return v ? { ...r, tier: v.tier, reason: v.reason, note: v.note ?? null } : r;
  });
}

export const stillChecking = (results) => results.some((r) => r.tier === 'checking');

// 3725 -> "1:02:05", 65 -> "1:05".
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
