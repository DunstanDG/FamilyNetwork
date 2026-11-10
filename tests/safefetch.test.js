import { describe, it, expect } from 'vitest';
import { BlockedAddress, readCapped, safeFetch } from '../supabase/functions/_shared/safeFetch.js';

const redirect = (to, status = 302) => new Response(null, { status, headers: { location: to } });
const publicDns = async () => ['93.184.216.34'];

describe('safeFetch', () => {
  it('follows public redirects and reports where it ended up', async () => {
    const seen = [];
    const f = async (url, init) => { seen.push([url, init.redirect]); return url.endsWith('/a') ? redirect('/b') : new Response('feed'); };
    const res = await safeFetch('https://feeds.example/a', {}, { fetch: f, resolve: publicDns });
    expect(await res.text()).toBe('feed');
    expect(res.finalUrl).toBe('https://feeds.example/b');
    expect(seen).toEqual([['https://feeds.example/a', 'manual'], ['https://feeds.example/b', 'manual']]);
  });

  it('refuses a public feed that redirects to an internal address, before fetching it', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data', 'http://localhost:5432/', 'http://192.168.1.10/admin', 'file:///etc/passwd']) {
      const seen = [];
      const f = async (url) => { seen.push(url); return redirect(target); };
      await expect(safeFetch('https://feeds.example/rss', {}, { fetch: f, resolve: publicDns })).rejects.toBeInstanceOf(BlockedAddress);
      expect(seen).toEqual(['https://feeds.example/rss']);
    }
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    const f = async () => new Response('secret');
    const resolve = async (host) => (host === 'sneaky.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    await expect(safeFetch('https://sneaky.example/', {}, { fetch: f, resolve })).rejects.toBeInstanceOf(BlockedAddress);
    await expect(safeFetch('https://nowhere.example/', {}, { fetch: f, resolve: async () => [] })).rejects.toThrow(/find/);
  });

  it('passes 304 Not Modified straight back, and stops redirect loops', async () => {
    const notModified = await safeFetch('https://feeds.example/rss', {}, { fetch: async () => new Response(null, { status: 304 }), resolve: publicDns });
    expect(notModified.status).toBe(304);
    await expect(safeFetch('https://feeds.example/loop', {}, { fetch: async () => redirect('/loop'), resolve: publicDns })).rejects.toThrow(/redirects/);
  });

  it('caps how much it reads', async () => {
    expect(await readCapped(new Response('abcdef'), 3)).toBe('abc');
    await expect(readCapped(new Response('abcdef'), 3, true)).rejects.toThrow();
  });
});
