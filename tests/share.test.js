import { describe, it, expect } from 'vitest';
import { buildPost, readShare } from '../src/lib/share.js';
import { clock, dayLabel, length, progressLabel, resumeAt } from '../src/lib/media.js';

describe('turning a link into a post', () => {
  it('makes a plain update when there is no link', () => {
    expect(buildPost({ text: '  hello  ' })).toEqual({ kind: 'update', body: 'hello', payload: {} });
  });
  it('makes a video post from a YouTube link, keeping the title and channel', () => {
    const p = buildPost({ text: 'watch this', url: 'https://youtu.be/dQw4w9WgXcQ', preview: { title: 'A song', site: 'Rick', image: 'https://i.ytimg.com/x.jpg' } });
    expect(p).toMatchObject({ kind: 'video', body: 'watch this', payload: { url: 'https://youtu.be/dQw4w9WgXcQ', video_id: 'dQw4w9WgXcQ', title: 'A song', source_title: 'Rick' } });
  });
  it('makes a podcast post, playable when there is audio', () => {
    const apple = buildPost({ url: 'https://podcasts.apple.com/gb/podcast/x/id1?i=2', preview: { title: 'Ep', site: 'Apple Podcasts', audio_url: 'https://cdn.example/a.mp3' } });
    expect(apple).toMatchObject({ kind: 'podcast_episode', payload: { title: 'Ep', audio_url: 'https://cdn.example/a.mp3' } });
    expect(buildPost({ url: 'https://cdn.example/ep.mp3' }).payload.audio_url).toBe('https://cdn.example/ep.mp3');
    expect(buildPost({ url: 'https://open.spotify.com/episode/x' }).payload.audio_url).toBeUndefined();
  });
  it('makes a news post from anything else, dropping unsafe preview images and junk', () => {
    const p = buildPost({ url: 'example.com/story', preview: { title: ' Story ', image: 'http://insecure.example/a.jpg', description: '' } });
    expect(p).toEqual({ kind: 'link', body: '', payload: { url: 'https://example.com/story', preview: { title: 'Story' } } });
    expect(buildPost({ url: 'https://example.com/a', preview: { title: '', image: 'javascript:1' } }).payload.preview).toBeUndefined();
  });
});

describe('reading what another app shared', () => {
  const params = (o) => new URLSearchParams(o);
  it('takes the url when given', () => {
    expect(readShare(params({ share_url: 'https://example.com/a', share_text: 'Look' }))).toEqual({ url: 'https://example.com/a', text: 'Look' });
  });
  it('finds the link inside the text, as Android usually sends it', () => {
    expect(readShare(params({ share_title: 'Video', share_text: 'Great one https://youtu.be/dQw4w9WgXcQ' }))).toEqual({ url: 'https://youtu.be/dQw4w9WgXcQ', text: 'Great one' });
  });
  it('keeps plain text, and ignores an empty share', () => {
    expect(readShare(params({ share_text: 'just words' }))).toEqual({ url: null, text: 'just words' });
    expect(readShare(params({}))).toBeNull();
  });
});

describe('media helpers', () => {
  it('formats times and lengths', () => {
    expect(clock(75)).toBe('1:15');
    expect(clock(3723)).toBe('1:02:03');
    expect(length(3723)).toBe('1 hr 2 min');
    expect(length(600)).toBe('10 min');
    expect(length(null)).toBe('');
  });
  it('says where you are up to and where to resume', () => {
    expect(progressLabel(null)).toBe('');
    expect(progressLabel({ position_seconds: 600, duration_seconds: 3600 })).toBe('50:00 left');
    expect(progressLabel({ position_seconds: 3590, duration_seconds: 3600 })).toBe('Played');
    expect(progressLabel({ finished: true })).toBe('Played');
    expect(resumeAt({ position_seconds: 600, duration_seconds: 3600 })).toBe(600);
    expect(resumeAt({ position_seconds: 3590, duration_seconds: 3600 })).toBe(0);
    expect(resumeAt({ position_seconds: 600, finished: true })).toBe(0);
  });
  it('names days', () => {
    const now = new Date('2026-11-03T10:00:00Z');
    expect(dayLabel('2026-11-03', now)).toBe('Today');
    expect(dayLabel('2026-11-02', now)).toBe('Yesterday');
    expect(dayLabel('2026-10-30', now)).toBe('Friday 30 October');
  });
});
