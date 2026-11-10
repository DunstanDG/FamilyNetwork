// Fetching an address someone in the family gave us (a feed, a link to preview) without letting it
// reach anything private. Every hop is checked, redirects included, and where the runtime can look up
// names (Deno.resolveDns in Supabase's Edge Functions) the addresses a name points at are checked too,
// so a public-looking name that resolves to an internal address is refused.
import { isPublicHttpUrl } from './links.js';

export class BlockedAddress extends Error {}

const defaultResolve = typeof Deno !== 'undefined' && typeof Deno.resolveDns === 'function'
  ? async (host) => {
    const found = [];
    for (const type of ['A', 'AAAA']) {
      try { found.push(...(await Deno.resolveDns(host, type))); } catch { /* no records of this type */ }
    }
    return found;
  }
  : null;

const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

async function check(url, resolve) {
  if (!isPublicHttpUrl(url)) throw new BlockedAddress('That address can’t be fetched.');
  if (!resolve) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIp(host)) return; // already checked as an address above
  const ips = await resolve(host);
  if (!ips.length) throw new BlockedAddress('Couldn’t find that site.');
  for (const ip of ips) {
    const literal = ip.includes(':') ? `[${ip}]` : ip;
    if (!isPublicHttpUrl(`http://${literal}/`)) throw new BlockedAddress('That address can’t be fetched.');
  }
}

// Like fetch(url, init), but redirects are followed by hand (at most `maxHops`) and every address on
// the way is checked. Resolves to the final, non-redirect Response.
export async function safeFetch(url, init = {}, { fetch: f = globalThis.fetch, resolve = defaultResolve, maxHops = 5 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    await check(current, resolve);
    // eslint-disable-next-line no-await-in-loop
    const res = await f(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
      res.body?.cancel?.();
      current = new URL(location, current).toString();
      continue;
    }
    return Object.defineProperty(res, 'finalUrl', { value: current });
  }
  throw new BlockedAddress('Too many redirects.');
}

// Read at most `max` bytes of a body. With `strict`, going over is an error; otherwise the rest is dropped.
export async function readCapped(res, max, strict = false) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      if (strict) throw new Error('That is too large.');
      chunks.push(value.subarray(0, value.length - (size - max)));
      size = max;
      break;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}
