// @mentions are plain text ("@Jane Smith") in the body. The people mentioned are worked out from the
// text when it is sent, so editing the text can never leave a stale mention behind.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionRegex(members) {
  const names = members.map((m) => m.display_name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@(${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

const byName = (members) => new Map(members.map((m) => [m.display_name.toLowerCase(), m]));

export function extractMentions(body, members) {
  const re = mentionRegex(members);
  if (!re) return [];
  const lookup = byName(members);
  const ids = new Set();
  for (const m of body.matchAll(re)) ids.add(lookup.get(m[2].toLowerCase())?.id);
  ids.delete(undefined);
  return [...ids];
}

// Splits text into plain, mention and link parts for display. Only http(s) links are made clickable.
export function tokenize(body, members) {
  const re = mentionRegex(members);
  const parts = [];
  const pushText = (text) => {
    const link = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/giu;
    let last = 0;
    for (const m of text.matchAll(link)) {
      if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
      parts.push({ type: 'link', value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  };
  if (!re) { pushText(body); return parts; }
  let last = 0;
  for (const m of body.matchAll(re)) {
    const start = m.index + m[1].length;
    if (start > last) pushText(body.slice(last, start));
    parts.push({ type: 'mention', value: `@${m[2]}` });
    last = start + m[2].length + 1;
  }
  if (last < body.length) pushText(body.slice(last));
  return parts;
}

// While typing: is the caret just after "@something"? Returns what was typed after the @.
export function activeMention(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\n@]{0,30})$/u.exec(before);
  if (!m) return null;
  return { query: m[2], start: before.length - m[2].length - 1 };
}

export function suggestMembers(query, members, selfId, limit = 5) {
  const q = query.toLowerCase();
  return members
    .filter((m) => m.id !== selfId)
    .filter((m) => {
      const name = m.display_name.toLowerCase();
      if (!q) return true;
      return q.includes(' ') ? name.startsWith(q) : name.split(/\s+/).some((w) => w.startsWith(q));
    })
    .slice(0, limit);
}

export function applyMention(text, caret, start, name) {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
