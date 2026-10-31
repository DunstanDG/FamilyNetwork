// The photo gateway: the only thing on the home server that the internet can reach.
//
// Every request must carry a family member's Supabase session. The gateway checks it, then talks to
// Immich with its own scoped API key. People only ever see our photo ids, never Immich's, so the
// gateway can't be used to browse the rest of the Immich library.
//
//   POST   /posts/:postId/photos     upload one photo (raw image body); location is stripped first
//   GET    /photos/:id/thumbnail     small square-ish thumbnail (default for timelines)
//   GET    /photos/:id/preview       large image for the full-screen viewer
//   GET    /photos/:id/original      the original file, as a download
//   GET    /me/export                a zip of every photo you have uploaded
//   GET    /health
import { randomUUID } from 'node:crypto';
import { UnsupportedImage, stripLocation } from './exif.js';
import { zipWriter } from './zip.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function ttlCache(ms, max = 500) {
  const m = new Map();
  return {
    get(k) {
      const hit = m.get(k);
      if (!hit) return undefined;
      if (hit.at + ms < Date.now()) { m.delete(k); return undefined; }
      return hit.v;
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { v, at: Date.now() });
    },
  };
}

export function createGateway(config) {
  const {
    supabaseUrl, anonKey, serviceKey, immichUrl, immichKey,
    allowedOrigins = [], maxBytes = 40 * 1024 * 1024, fetch: f = globalThis.fetch, log = console,
  } = config;
  const sessions = ttlCache(60_000);
  const members = ttlCache(60_000);

  const rest = (path, init = {}) => f(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'accept-profile': 'family', 'content-profile': 'family',
      'content-type': 'application/json', ...(init.headers || {}),
    },
  });
  const rpc = async (fn, args) => {
    const res = await rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status === 400 ? 403 : 502, body?.message || 'database error');
    return body;
  };
  const immich = (path, init = {}) => f(`${immichUrl}/api/${path}`, { ...init, headers: { 'x-api-key': immichKey, ...(init.headers || {}) } });

  async function whoIs(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'Please sign in.');
    const token = m[1];
    let user = sessions.get(token);
    if (!user) {
      const res = await f(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` } });
      if (!res.ok) throw new HttpError(401, 'Your sign-in has expired. Please sign in again.');
      user = await res.json();
      if (!user?.id) throw new HttpError(401, 'Please sign in.');
      sessions.set(token, user);
    }
    let member = members.get(user.id);
    if (member === undefined) {
      const res = await rest(`profiles?id=eq.${user.id}&select=id,role`);
      const rows = res.ok ? await res.json() : [];
      member = rows[0] || null;
      members.set(user.id, member);
    }
    if (!member) throw new HttpError(403, 'Family members only.');
    return member;
  }

  async function photoRow(id) {
    if (!UUID.test(id)) throw new HttpError(404, 'No such photo.');
    const res = await rest(`photo_assets?id=eq.${id}&select=id,immich_asset_id,post_id,uploaded_by,created_at,taken_at`);
    const rows = res.ok ? await res.json() : [];
    if (!rows[0]) throw new HttpError(404, 'No such photo.');
    return rows[0];
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-width, x-height, x-taken-at, x-position, x-filename');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-expose-headers', 'content-disposition, content-length');
      res.setHeader('access-control-max-age', '600');
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
  }

  const sendJson = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > maxBytes) { reject(new HttpError(413, 'That photo is too big.')); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { reject(new HttpError(413, 'That photo is too big.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function upload(req, res, postId) {
    const me = await whoIs(req);
    if (!UUID.test(postId)) throw new HttpError(404, 'No such post.');
    if (!(await rpc('photo_upload_allowed', { p_post: postId, p_user: me.id }))) {
      throw new HttpError(403, 'You can only add photos to your own album or update.');
    }
    const raw = await readBody(req);
    if (!raw.length) throw new HttpError(400, 'No photo was sent.');
    let clean;
    try { clean = stripLocation(raw); } catch (e) {
      if (e instanceof UnsupportedImage) throw new HttpError(415, e.message);
      throw e;
    }
    const num = (h) => (Number.isFinite(Number(req.headers[h])) && Number(req.headers[h]) > 0 ? Math.round(Number(req.headers[h])) : null);
    const takenRaw = req.headers['x-taken-at'];
    const taken = takenRaw && !Number.isNaN(Date.parse(takenRaw)) ? new Date(takenRaw).toISOString() : null;
    const when = taken || new Date().toISOString();

    const form = new FormData();
    form.append('deviceAssetId', `family-network-${randomUUID()}`);
    form.append('deviceId', 'family-network');
    form.append('fileCreatedAt', when);
    form.append('fileModifiedAt', when);
    form.append('assetData', new Blob([clean.bytes], { type: clean.type }), `photo.${EXT[clean.type]}`);
    const up = await immich('assets', { method: 'POST', body: form });
    const asset = await up.json().catch(() => null);
    if (!up.ok || !asset?.id) {
      log.error?.('immich upload failed', up.status, asset);
      throw new HttpError(502, 'The photo store didn’t accept that photo. Try again in a moment.');
    }
    try {
      const row = await rpc('record_photo', {
        p_post: postId, p_user: me.id, p_immich: asset.id, p_width: num('x-width'), p_height: num('x-height'),
        p_taken: taken, p_position: num('x-position') ?? 0,
      });
      sendJson(res, 201, { id: row.id, width: row.width, height: row.height });
    } catch (e) {
      if (asset.status !== 'duplicate') {
        await immich('assets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [asset.id], force: false }) }).catch(() => {});
      }
      throw e;
    }
  }

  async function serve(req, res, id, size) {
    await whoIs(req);
    const row = await photoRow(id);
    const path = size === 'original' ? `assets/${row.immich_asset_id}/original` : `assets/${row.immich_asset_id}/thumbnail?size=${size}`;
    const up = await immich(path);
    if (!up.ok) throw new HttpError(up.status === 404 ? 404 : 502, 'That photo isn’t available right now.');
    res.statusCode = 200;
    res.setHeader('content-type', up.headers.get('content-type') || 'application/octet-stream');
    if (up.headers.get('content-length')) res.setHeader('content-length', up.headers.get('content-length'));
    // Our photo ids never point at different bytes, so the browser may keep them (privately) for a week.
    res.setHeader('cache-control', 'private, max-age=604800, immutable');
    if (size === 'original') {
      const ext = EXT[(up.headers.get('content-type') || '').split(';')[0]] || 'jpg';
      res.setHeader('content-disposition', `attachment; filename="family-photo-${row.id.slice(0, 8)}.${ext}"`);
    }
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  async function exportMine(req, res) {
    const me = await whoIs(req);
    const list = await rest(`photo_assets?uploaded_by=eq.${me.id}&select=id,immich_asset_id,taken_at,created_at&order=created_at`);
    const rows = list.ok ? await list.json() : [];
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-disposition', 'attachment; filename="my-family-photos.zip"');
    const zip = zipWriter((b) => res.write(b));
    const used = new Set();
    for (const r of rows) {
      const up = await immich(`assets/${r.immich_asset_id}/original`);
      if (!up.ok) continue;
      const bytes = Buffer.from(await up.arrayBuffer());
      const date = new Date(r.taken_at || r.created_at);
      const ext = EXT[(up.headers.get('content-type') || '').split(';')[0]] || 'jpg';
      let name = `${date.toISOString().slice(0, 10)}-${r.id.slice(0, 8)}.${ext}`;
      while (used.has(name)) name = `x-${name}`;
      used.add(name);
      zip.add(name, bytes, date);
    }
    zip.finish();
    res.end();
  }

  // Empty the queue of Immich assets whose posts were deleted. Moves them to Immich's bin (30 days).
  async function sweep() {
    const res = await rest('photo_deletions?select=immich_asset_id&limit=200');
    if (!res.ok) return 0;
    const ids = (await res.json()).map((r) => r.immich_asset_id);
    if (!ids.length) return 0;
    const del = await immich('assets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, force: false }) });
    if (!del.ok && del.status !== 400) return 0;
    await rest(`photo_deletions?immich_asset_id=in.(${ids.map((i) => `"${i}"`).join(',')})`, { method: 'DELETE' });
    return ids.length;
  }

  async function handler(req, res) {
    cors(req, res);
    try {
      const url = new URL(req.url, 'http://gateway');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && parts.length === 3 && parts[0] === 'posts' && parts[2] === 'photos') { await upload(req, res, parts[1]); return; }
      if (req.method === 'GET' && parts.length === 3 && parts[0] === 'photos' && ['thumbnail', 'preview', 'original'].includes(parts[2])) {
        await serve(req, res, parts[1], parts[2]); return;
      }
      if (req.method === 'GET' && url.pathname === '/me/export') { await exportMine(req, res); return; }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error?.(e);
      sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong.' });
    }
  }

  return { handler, sweep };
}
