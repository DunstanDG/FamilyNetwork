// Removes location data from photos before they are stored, without re-encoding the image (so the
// original quality, orientation and date are kept).
//
//   JPEG: empties the EXIF GPS block, and drops XMP (which can repeat the location).
//   PNG:  drops eXIf and XMP chunks.
//   WebP: drops EXIF and XMP chunks.
// Anything else is refused: we can't promise the location is gone.

export class UnsupportedImage extends Error {}

const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Zero the GPS IFD inside a TIFF/EXIF block, in place. Returns false if the block can't be read.
function wipeGps(tiff) {
  if (tiff.length < 8) return false;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const le = order === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return false;
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return false;
  const n0 = u16(ifd0);
  if (ifd0 + 2 + n0 * 12 > tiff.length) return false;
  for (let i = 0; i < n0; i += 1) {
    const e = ifd0 + 2 + i * 12;
    if (u16(e) !== 0x8825) continue;
    const gps = u32(e + 8);
    if (gps + 2 > tiff.length) return false;
    const n = u16(gps);
    const end = gps + 2 + n * 12 + 4;
    if (end > tiff.length) return false;
    for (let j = 0; j < n; j += 1) {
      const g = gps + 2 + j * 12;
      const size = (TYPE_SIZE[u16(g + 2)] || 1) * u32(g + 4);
      if (size > 4) {
        const at = u32(g + 8);
        if (at + size > tiff.length) return false;
        tiff.fill(0, at, at + size);
      }
    }
    tiff.fill(0, gps, end); // entry count 0, no entries, no next IFD
  }
  return true;
}

function stripJpeg(input) {
  const buf = Buffer.from(input);
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new UnsupportedImage('This photo looks damaged.');
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xda || marker === 0xd9) { out.push(buf.subarray(i)); return Buffer.concat(out); } // image data: copy the rest
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) throw new UnsupportedImage('This photo looks damaged.');
    const seg = buf.subarray(i, end);
    if (marker === 0xe1) {
      const body = seg.subarray(4);
      if (body.toString('latin1', 0, 6) === 'Exif\0\0') {
        // Keep EXIF (orientation, date) with the GPS block emptied; if it can't be read, drop it all.
        if (wipeGps(body.subarray(6))) out.push(seg);
        i = end; continue;
      }
      if (body.toString('latin1', 0, XMP_SIG.length) === XMP_SIG || body.toString('latin1', 0, 34).startsWith('http://ns.adobe.com/xmp/extension/')) {
        i = end; continue; // drop XMP
      }
    }
    out.push(seg);
    i = end;
  }
  throw new UnsupportedImage('This photo looks damaged.');
}

function stripPng(input) {
  const buf = Buffer.from(input);
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new UnsupportedImage('This photo looks damaged.');
    const isXmp = (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') && buf.toString('latin1', i + 8, i + 8 + 17) === 'XML:com.adobe.xmp';
    if (type !== 'eXIf' && !isXmp) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new UnsupportedImage('This photo looks damaged.');
}

function stripWebp(input) {
  const buf = Buffer.from(input);
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > buf.length) throw new UnsupportedImage('This photo looks damaged.');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
      if (type === 'VP8X' && len >= 1) chunk[8] &= ~(0x08 | 0x04); // clear the "has EXIF" and "has XMP" flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// Returns { bytes, type } with location removed, or throws UnsupportedImage.
export function stripLocation(input) {
  const type = sniff(input);
  if (type === 'image/jpeg') return { bytes: stripJpeg(input), type };
  if (type === 'image/png') return { bytes: stripPng(input), type };
  if (type === 'image/webp') return { bytes: stripWebp(input), type };
  throw new UnsupportedImage('Only JPEG, PNG and WebP photos can be shared. On iPhone, set Camera → Formats → Most Compatible.');
}

// Does this block of bytes still carry any GPS coordinates? (Used by the tests.)
export function hasGps(input) {
  const buf = Buffer.from(input);
  if (sniff(buf) !== 'image/jpeg') return false;
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff && buf[i + 1] !== 0xda) {
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i + 4, i + 2 + len);
    if (buf[i + 1] === 0xe1 && seg.toString('latin1', 0, 6) === 'Exif\0\0') {
      const tiff = seg.subarray(6);
      const le = tiff.toString('latin1', 0, 2) === 'II';
      const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
      const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
      const ifd0 = u32(4);
      for (let k = 0; k < u16(ifd0); k += 1) {
        const e = ifd0 + 2 + k * 12;
        if (u16(e) === 0x8825 && u16(u32(e + 8)) > 0) return true;
      }
    }
    if (buf[i + 1] === 0xe1 && seg.toString('latin1', 0, XMP_SIG.length) === XMP_SIG && /GPS/i.test(seg.toString('latin1'))) return true;
    i += 2 + len;
  }
  return false;
}
