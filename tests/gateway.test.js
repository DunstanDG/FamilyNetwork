// The photo gateway: location stripping, the zip export, and every request's sign-in check,
// against fake Supabase and Immich servers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { hasGps, sniff, stripLocation } from '../gateway/src/exif.js';
import { crc32, zipWriter } from '../gateway/src/zip.js';
import { createGateway } from '../gateway/src/gateway.js';

// ---- a small JPEG with a GPS block (and an XMP packet that repeats the location) ---------------
function jpegWithGps() {
  // TIFF (little endian): header, IFD0 with one entry (GPS pointer), GPS IFD with two entries.
  const t = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 24 + 4 + 24);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8);                                   // IFD0: 1 entry
  t.writeUInt16LE(0x8825, 10); t.writeUInt16LE(4, 12); t.writeUInt32LE(1, 14); t.writeUInt32LE(26, 18);
  t.writeUInt32LE(0, 22);                                  // no IFD1
  const gps = 26;
  t.writeUInt16LE(2, gps);
  t.writeUInt16LE(1, gps + 2); t.writeUInt16LE(2, gps + 4); t.writeUInt32LE(2, gps + 6); t.write('N\0', gps + 10, 'latin1');
  const dataAt = gps + 2 + 24 + 4;
  t.writeUInt16LE(2, gps + 14); t.writeUInt16LE(5, gps + 16); t.writeUInt32LE(3, gps + 18); t.writeUInt32LE(dataAt, gps + 22);
  for (let i = 0; i < 6; i += 1) t.writeUInt32LE(51 + i, dataAt + i * 4); // 51/52, 53/54, 55/56 degrees...
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(exif.length + 2), exif]);
  const xmpBody = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>51,30N</exif:GPSLatitude></x:xmpmeta>', 'latin1');
  const xmp = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(xmpBody.length + 2), xmpBody]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb]), u16be(4), Buffer.from([0, 1])]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0x56, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, xmp, dqt, sos]);
}
function u16be(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }

function pngWithExif() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('eXIf', Buffer.from('MM\0*GPS!')), chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND', Buffer.alloc(0))]);
}

function webpWithExif() {
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04;
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', vp8x), chunk('VP8 ', Buffer.from([9, 9, 9])), chunk('EXIF', Buffer.from('GPSDATA')), chunk('XMP ', Buffer.from('<xmp/>'))]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

describe('location stripping', () => {
  it('empties the GPS block of a JPEG and drops XMP, keeping the image data byte for byte', () => {
    const before = jpegWithGps();
    expect(hasGps(before)).toBe(true);
    const { bytes, type } = stripLocation(before);
    expect(type).toBe('image/jpeg');
    expect(hasGps(bytes)).toBe(false);
    expect(bytes.includes(Buffer.from('GPSLatitude'))).toBe(false);
    for (let v = 51; v <= 56; v += 1) { const b = Buffer.alloc(4); b.writeUInt32LE(v); expect(bytes.includes(b)).toBe(false); }
    expect(bytes.subarray(-9).equals(before.subarray(-9))).toBe(true);  // scan data untouched
    expect(bytes.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(true); // rest of EXIF kept
  });
  it('drops EXIF and XMP from PNG and WebP, fixing the WebP headers', () => {
    const png = stripLocation(pngWithExif()).bytes;
    expect(png.includes(Buffer.from('eXIf'))).toBe(false);
    expect(png.includes(Buffer.from('IDAT'))).toBe(true);
    const webp = stripLocation(webpWithExif()).bytes;
    expect(webp.includes(Buffer.from('EXIF'))).toBe(false);
    expect(webp.includes(Buffer.from('XMP '))).toBe(false);
    expect(webp.readUInt32LE(4)).toBe(webp.length - 8);
    expect(webp[20] & 0x0c).toBe(0); // VP8X flags cleared
  });
  it('refuses formats it cannot clean, and damaged files', () => {
    expect(() => stripLocation(Buffer.from('....ftypheic....'))).toThrow(/JPEG, PNG and WebP/);
    expect(() => stripLocation(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toThrow(/damaged/);
    expect(sniff(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('zip export', () => {
  it('writes a valid stored zip', () => {
    const parts = [];
    const z = zipWriter((b) => parts.push(b));
    z.add('a.jpg', Buffer.from('hello'), new Date('2026-10-31T10:00:00'));
    z.add('b.jpg', Buffer.from('world!'), new Date('2026-10-31T10:00:00'));
    z.finish();
    const zip = Buffer.concat(parts);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(14)).toBe(crc32(Buffer.from('hello')));
    const end = zip.subarray(-22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(2);
    expect(zip.readUInt32LE(end.readUInt32LE(16))).toBe(0x02014b50);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

// ---- the gateway against fake backends ---------------------------------------------------------
const MEMBER = '00000000-0000-4000-8000-0000000000aa';
const OUTSIDER = '00000000-0000-4000-8000-0000000000bb';
const POST = '50000000-0000-4000-8000-000000000001';
const PHOTO = '60000000-0000-4000-8000-000000000001';

describe('gateway', () => {
  let server; let base; const calls = []; let uploaded = null; const allowed = { value: true };

  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push(`${init.method || 'GET'} ${u.host}${u.pathname}${u.search}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'sb.test') {
      if (u.pathname === '/auth/v1/user') {
        const token = h.authorization?.replace('Bearer ', '');
        return token === 'member-token' ? json({ id: MEMBER }) : token === 'outsider-token' ? json({ id: OUTSIDER }) : json({ msg: 'bad jwt' }, 401);
      }
      expect(h.authorization).toBe('Bearer service-key');
      if (u.pathname === '/rest/v1/profiles') return json(u.search.includes(MEMBER) ? [{ id: MEMBER, role: 'adult' }] : []);
      if (u.pathname === '/rest/v1/rpc/photo_upload_allowed') return json(allowed.value);
      if (u.pathname === '/rest/v1/rpc/record_photo') {
        const b = JSON.parse(init.body);
        return json({ id: PHOTO, width: b.p_width, height: b.p_height });
      }
      if (u.pathname === '/rest/v1/photo_assets') {
        if (u.search.includes(`id=eq.${PHOTO}`) || u.search.includes(`uploaded_by=eq.${MEMBER}`)) {
          return json([{ id: PHOTO, immich_asset_id: 'imm-1', post_id: POST, uploaded_by: MEMBER, created_at: '2026-10-31T10:00:00Z', taken_at: null }]);
        }
        return json([]);
      }
      if (u.pathname === '/rest/v1/photo_deletions') return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json([{ immich_asset_id: 'gone-1' }]);
    }
    if (u.host === 'immich.test') {
      expect(h['x-api-key']).toBe('immich-key');
      if (u.pathname === '/api/assets' && init.method === 'POST') {
        uploaded = Buffer.from(await init.body.get('assetData').arrayBuffer());
        return json({ id: 'imm-new', status: 'created' }, 201);
      }
      if (u.pathname === '/api/assets' && init.method === 'DELETE') return new Response(null, { status: 204 });
      if (u.pathname === '/api/assets/imm-1/thumbnail') return new Response('THUMB', { headers: { 'content-type': 'image/webp' } });
      if (u.pathname === '/api/assets/imm-1/original') return new Response('ORIGINAL', { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('unexpected', { status: 599 });
  };

  beforeAll(async () => {
    const gw = createGateway({
      supabaseUrl: 'https://sb.test', anonKey: 'anon', serviceKey: 'service-key', immichUrl: 'http://immich.test', immichKey: 'immich-key',
      allowedOrigins: ['https://family.example'], fetch: fakeFetch, maxBytes: 1024 * 1024, log: { error() {} },
    });
    server = createServer(gw.handler);
    server.sweep = gw.sweep;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const get = (path, token, extra = {}) => fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

  it('refuses requests without a valid family sign-in', async () => {
    expect((await get(`/photos/${PHOTO}/thumbnail`)).status).toBe(401);
    expect((await get(`/photos/${PHOTO}/thumbnail`, 'forged')).status).toBe(401);
    expect((await get(`/photos/${PHOTO}/thumbnail`, 'outsider-token')).status).toBe(403);
    expect(calls.some((c) => c.includes('immich.test'))).toBe(false);
  });

  it('serves thumbnails and originals for our own photo ids only', async () => {
    const t = await get(`/photos/${PHOTO}/thumbnail`, 'member-token', { origin: 'https://family.example' });
    expect(t.status).toBe(200);
    expect(await t.text()).toBe('THUMB');
    expect(t.headers.get('cache-control')).toContain('private');
    expect(t.headers.get('access-control-allow-origin')).toBe('https://family.example');
    expect(calls).toContain('GET immich.test/api/assets/imm-1/thumbnail?size=thumbnail');

    const o = await get(`/photos/${PHOTO}/original`, 'member-token');
    expect(await o.text()).toBe('ORIGINAL');
    expect(o.headers.get('content-disposition')).toMatch(/attachment; filename="family-photo-60000000\.jpg"/);

    expect((await get('/photos/60000000-0000-4000-8000-000000000999/preview', 'member-token')).status).toBe(404);
    expect((await get('/photos/imm-1/original', 'member-token')).status).toBe(404); // Immich ids are not accepted
  });

  it('does not answer other sites', async () => {
    const t = await get(`/photos/${PHOTO}/thumbnail`, 'member-token', { origin: 'https://evil.example' });
    expect(t.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('strips the location before a photo reaches Immich, and records it', async () => {
    const res = await fetch(`${base}/posts/${POST}/photos`, {
      method: 'POST', body: jpegWithGps(),
      headers: { authorization: 'Bearer member-token', 'content-type': 'image/jpeg', 'x-width': '800', 'x-height': '600', 'x-taken-at': '2026-08-01T12:00:00Z' },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: PHOTO, width: 800, height: 600 });
    expect(hasGps(uploaded)).toBe(false);
  });

  it('refuses uploads to posts that are not yours, and files it cannot clean', async () => {
    allowed.value = false;
    const no = await fetch(`${base}/posts/${POST}/photos`, { method: 'POST', body: jpegWithGps(), headers: { authorization: 'Bearer member-token' } });
    expect(no.status).toBe(403);
    allowed.value = true;
    const heic = await fetch(`${base}/posts/${POST}/photos`, { method: 'POST', body: Buffer.from('....ftypheic'), headers: { authorization: 'Bearer member-token' } });
    expect(heic.status).toBe(415);
    expect((await heic.json()).error).toMatch(/JPEG/);
    const big = await fetch(`${base}/posts/${POST}/photos`, { method: 'POST', body: Buffer.alloc(2 * 1024 * 1024), headers: { authorization: 'Bearer member-token' } });
    expect(big.status).toBe(413);
  });

  it('exports your own photos as a zip', async () => {
    const res = await get('/me/export', 'member-token');
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await res.arrayBuffer());
    expect(zip.includes(Buffer.from('ORIGINAL'))).toBe(true);
    expect(zip.subarray(-22).readUInt16LE(10)).toBe(1);
  });

  it('moves deleted photos to the Immich bin', async () => {
    expect(await server.sweep()).toBe(1);
    expect(calls).toContain('DELETE immich.test/api/assets');
    expect(calls.some((c) => c.startsWith('DELETE sb.test/rest/v1/photo_deletions'))).toBe(true);
  });
});
