import { describe, it, expect, beforeEach } from 'vitest';
import { extractMentions, tokenize, activeMention, suggestMembers, applyMention } from '../src/lib/mentions.js';
import { findUnreadDivider, summariseReactions, mergePosts, sortPosts, normaliseLink, initials } from '../src/lib/timeline.js';
import { ago, canEdit } from '../src/lib/time.js';
import * as outbox from '../src/lib/outbox.js';
import { set } from '../src/lib/idb.js';

const members = [
  { id: 'jane', display_name: 'Jane Smith' },
  { id: 'jan', display_name: 'Jan' },
  { id: 'zoe', display_name: 'Zoë' },
  { id: 'me', display_name: 'Me Myself' },
];

describe('mentions', () => {
  it('finds each mentioned member once, preferring the longest matching name', () => {
    expect(extractMentions('hi @Jane Smith and @jan, also @Jane Smith again', members).sort()).toEqual(['jan', 'jane']);
  });
  it('does not treat a longer name as a mention of a shorter one, or emails as mentions', () => {
    expect(extractMentions('@Janet is not here', members)).toEqual([]);
    expect(extractMentions('write to bob@Jan.example', members)).toEqual([]);
  });
  it('handles accented names and no members', () => {
    expect(extractMentions('thanks @Zoë!', members)).toEqual(['zoe']);
    expect(extractMentions('anyone @there', [])).toEqual([]);
  });
  it('tokenizes mentions and links for display, leaving look-alike text alone', () => {
    const parts = tokenize('Hi @Jan see https://example.com/a?b=1. Thanks', members);
    expect(parts.map((p) => p.type)).toEqual(['text', 'mention', 'text', 'link', 'text']);
    expect(parts[3].value).toBe('https://example.com/a?b=1');
    expect(tokenize('javascript:alert(1) and ftp://x', members).every((p) => p.type === 'text')).toBe(true);
  });
  it('detects an @ being typed and completes it', () => {
    const text = 'Hello @ja';
    const active = activeMention(text, text.length);
    expect(active).toEqual({ query: 'ja', start: 6 });
    expect(suggestMembers('ja', members, 'me').map((m) => m.id)).toEqual(['jane', 'jan']);
    expect(suggestMembers('smith', members, 'me').map((m) => m.id)).toEqual(['jane']);
    expect(suggestMembers('', members, 'me').map((m) => m.id)).not.toContain('me');
    expect(applyMention(text, text.length, active.start, 'Jane Smith')).toEqual({ text: 'Hello @Jane Smith ', caret: 18 });
    expect(activeMention('mail me@jan', 11)).toBeNull();
    expect(activeMention('done @Jan and then some more words here yes', 42)).toBeNull();
  });
});

describe('timeline', () => {
  const post = (id, created_at, author_id = 'other', pinned = false) => ({ id, created_at, author_id, pinned });
  it('draws the unread line above the first post you had already seen', () => {
    const posts = [post('a', '2026-10-31T12:00:00Z'), post('b', '2026-10-31T11:00:00Z', 'me'), post('c', '2026-10-30T09:00:00Z')];
    expect(findUnreadDivider(posts, '2026-10-31T10:00:00Z', 'me')).toEqual({ index: 2, count: 1 });
  });
  it('shows no line when the only new posts are your own, or nothing is new, or there is no baseline', () => {
    const mine = [post('a', '2026-10-31T12:00:00Z', 'me'), post('c', '2026-10-30T09:00:00Z')];
    expect(findUnreadDivider(mine, '2026-10-31T10:00:00Z', 'me')).toBeNull();
    expect(findUnreadDivider([post('c', '2026-10-30T09:00:00Z')], '2026-10-31T10:00:00Z', 'me')).toBeNull();
    expect(findUnreadDivider(mine, null, 'me')).toBeNull();
  });
  it('ignores pinned posts and puts the line at the end when everything is new', () => {
    const posts = [post('p', '2020-01-01T00:00:00Z', 'other', true), post('a', '2026-10-31T12:00:00Z')];
    expect(findUnreadDivider(posts, '2026-10-31T10:00:00Z', 'me')).toEqual({ index: 2, count: 1 });
  });
  it('counts reactions per emoji and whether you reacted', () => {
    const s = summariseReactions([{ emoji: 'heart', user_id: 'me' }, { emoji: 'heart', user_id: 'x' }, { emoji: 'wow', user_id: 'x' }], 'me');
    expect(s.find((r) => r.key === 'heart')).toMatchObject({ count: 2, mine: true });
    expect(s.find((r) => r.key === 'wow')).toMatchObject({ count: 1, mine: false });
    expect(s.find((r) => r.key === 'laugh')).toMatchObject({ count: 0, mine: false });
  });
  it('keeps older loaded posts when the first page refreshes', () => {
    const fresh = [post('n', '2026-10-31T12:00:00Z'), post('a', '2026-10-31T11:00:00Z')];
    const existing = [post('a', '2026-10-31T11:00:00Z'), post('b', '2026-10-30T11:00:00Z'), post('c', '2026-10-29T11:00:00Z')];
    expect(mergePosts(fresh, existing).map((p) => p.id)).toEqual(['n', 'a', 'b', 'c']);
  });
  it('sorts pinned first then newest first', () => {
    const sorted = sortPosts([post('old', '2026-01-01'), post('new', '2026-02-01'), post('pin', '2025-01-01', 'x', true)]);
    expect(sorted.map((p) => p.id)).toEqual(['pin', 'new', 'old']);
  });
  it('accepts only http(s) links', () => {
    expect(normaliseLink('example.com/a')).toBe('https://example.com/a');
    expect(normaliseLink('  http://example.com ')).toBe('http://example.com/');
    expect(normaliseLink('javascript:alert(1)')).toBeNull();
    expect(normaliseLink('')).toBeNull();
    expect(normaliseLink('not a url at all')).toBeNull();
  });
  it('makes initials', () => {
    expect(initials('Jane Smith')).toBe('JS');
    expect(initials('  ')).toBe('?');
  });
});

describe('time', () => {
  const now = new Date('2026-10-31T12:00:00Z').getTime();
  it('words recent times plainly', () => {
    expect(ago('2026-10-31T11:59:30Z', now)).toBe('Just now');
    expect(ago('2026-10-31T11:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-10-31T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-10-30T09:00:00Z', now)).toBe('Yesterday');
    expect(ago('2026-10-27T09:00:00Z', now)).toBe('4 days ago');
    expect(ago('2026-09-01T09:00:00Z', now)).toBe('1 Sept');
  });
  it('allows edits for fifteen minutes', () => {
    expect(canEdit('2026-10-31T11:50:00Z', now)).toBe(true);
    expect(canEdit('2026-10-31T11:44:00Z', now)).toBe(false);
  });
});

describe('outbox', () => {
  beforeEach(async () => { await set('outbox', []); });
  const entry = (id) => ({ id, type: 'post', data: { id } });

  it('sends queued items in order and clears them', async () => {
    await outbox.enqueue(entry('1')); await outbox.enqueue(entry('2'));
    const order = [];
    const res = await outbox.flush(async (e) => { order.push(e.id); return {}; });
    expect(order).toEqual(['1', '2']);
    expect(res).toMatchObject({ sent: 2, items: [] });
  });
  it('does not queue the same item twice', async () => {
    await outbox.enqueue(entry('1')); await outbox.enqueue(entry('1'));
    expect(await outbox.list()).toHaveLength(1);
  });
  it('treats an already-saved item (duplicate key) as sent', async () => {
    await outbox.enqueue(entry('1'));
    const res = await outbox.flush(async () => ({ error: { code: '23505', message: 'duplicate' } }));
    expect(res.items).toEqual([]);
  });
  it('stops and keeps everything on a network error, preserving order', async () => {
    await outbox.enqueue(entry('1')); await outbox.enqueue(entry('2'));
    const seen = [];
    const res = await outbox.flush(async (e) => { seen.push(e.id); return { error: { message: 'TypeError: Failed to fetch' } }; });
    expect(seen).toEqual(['1']);
    expect(res.items.map((i) => i.id)).toEqual(['1', '2']);
  });
  it('stops on an expired sign-in too', async () => {
    await outbox.enqueue(entry('1'));
    const res = await outbox.flush(async () => ({ error: { status: 401, message: 'JWT expired' } }));
    expect(res.items).toHaveLength(1);
    expect(res.items[0].failed).toBeUndefined();
  });
  it('marks a rejected item failed and carries on with the rest', async () => {
    await outbox.enqueue(entry('1')); await outbox.enqueue(entry('2'));
    const res = await outbox.flush(async (e) => (e.id === '1' ? { error: { code: '42501', message: 'not allowed' } } : {}));
    expect(res.sent).toBe(1);
    expect(res.items).toEqual([expect.objectContaining({ id: '1', failed: 'not allowed' })]);
    // a failed item is not retried
    const again = await outbox.flush(async () => { throw new Error('should not be called'); });
    expect(again.sent).toBe(0);
  });
  it('does not run two flushes at once', async () => {
    await outbox.enqueue(entry('1'));
    let calls = 0;
    const slow = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return {}; };
    await Promise.all([outbox.flush(slow), outbox.flush(slow)]);
    expect(calls).toBe(1);
  });
});
