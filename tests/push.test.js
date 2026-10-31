import { describe, it, expect } from 'vitest';
import { buildPayload, isMuted, safeEqual } from '../supabase/functions/send-push/logic.ts';

describe('push decisions', () => {
  it('words each kind of notification', () => {
    const base = { module: 'update', post_id: 'p1', snippet: 'See you Sunday' };
    expect(buildPayload({ ...base, kind: 'mention' }, 'Jane')).toEqual({ title: 'Jane mentioned you', body: 'See you Sunday', postId: 'p1', tag: 'post-p1' });
    expect(buildPayload({ ...base, kind: 'reply' }, 'Jan').title).toBe('Jan replied to you');
  });
  it('copes with a missing name, snippet or post, and trims long text', () => {
    const p = buildPayload({ kind: 'reply', module: 'update', post_id: null, snippet: 'x'.repeat(500) }, null);
    expect(p.title).toBe('Someone replied to you');
    expect(p.body).toHaveLength(140);
    expect(p.tag).toBeUndefined();
    expect(buildPayload({ kind: 'reply', module: 'update', post_id: null, snippet: null }, 'A').body).toBe('');
  });
  it('respects per-module muting', () => {
    expect(isMuted(['video', 'link'], 'video')).toBe(true);
    expect(isMuted(['video'], 'update')).toBe(false);
    expect(isMuted([], 'update')).toBe(false);
    expect(isMuted(null, 'update')).toBe(false);
  });
  it('compares secrets exactly', () => {
    expect(safeEqual('s3cret', 's3cret')).toBe(true);
    expect(safeEqual('s3cret', 's3cree')).toBe(false);
    expect(safeEqual('s3cret', 's3cret!')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
