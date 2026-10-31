// Talking to the photo gateway on the home server. Every request carries the person's session;
// images come back as blobs (an <img> can't send a sign-in header) and thumbnails are kept on the
// device so the timeline still has its pictures offline.
import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';

export const GATEWAY = (import.meta.env.VITE_PHOTO_GATEWAY_URL || '').replace(/\/$/, '');
export const photosConfigured = Boolean(GATEWAY);

const CACHE = 'family-photos-v1';
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

async function token() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || '';
}

const cacheKey = (id, size) => `${GATEWAY}/photos/${id}/${size}`;

async function fromCache(key) {
  try { return await (await caches.open(CACHE)).match(key); } catch { return undefined; }
}

async function toCache(key, res) {
  try { await (await caches.open(CACHE)).put(key, res); } catch { /* storage full or unavailable */ }
}

export async function fetchPhoto(id, size = 'thumbnail') {
  const key = cacheKey(id, size);
  const keep = size !== 'original';
  if (keep) {
    const hit = await fromCache(key);
    if (hit) return hit.blob();
  }
  const res = await fetch(key, { headers: { authorization: `Bearer ${await token()}` } });
  if (!res.ok) {
    let message = `The photo store answered ${res.status}.`;
    try { message = (await res.json()).error || message; } catch { /* not json */ }
    throw new Error(message);
  }
  if (keep) await toCache(key, res.clone());
  return res.blob();
}

// <img src> for a photo: a blob address once loaded, null while loading.
export function usePhotoUrl(id, size = 'thumbnail') {
  const [state, setState] = useState({ url: null, error: '' });
  useEffect(() => {
    if (!id || !photosConfigured) return undefined;
    let url = null;
    let alive = true;
    setState({ url: null, error: '' });
    fetchPhoto(id, size).then((blob) => {
      url = URL.createObjectURL(blob);
      if (alive) setState({ url, error: '' }); else URL.revokeObjectURL(url);
    }, (e) => { if (alive) setState({ url: null, error: e.message }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [id, size]);
  return state;
}

export async function downloadOriginal(id) {
  const blob = await fetchPhoto(id, 'original');
  const ext = { 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg';
  saveBlob(blob, `family-photo-${id.slice(0, 8)}.${ext}`);
}

export async function downloadMyPhotos() {
  const res = await fetch(`${GATEWAY}/me/export`, { headers: { authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new Error('Couldn’t make the download. Try again later.');
  saveBlob(await res.blob(), 'my-family-photos.zip');
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function checkFile(file) {
  if (!ACCEPT.includes(file.type)) {
    return /heic|heif/i.test(file.type || file.name)
      ? 'iPhone HEIC photos can’t be shared yet. On iPhone, choose “Most Compatible” in Settings → Camera → Formats.'
      : 'Only photos (JPEG, PNG or WebP) can be shared.';
  }
  if (file.size > 40 * 1024 * 1024) return 'That photo is over 40 MB.';
  return null;
}

async function dimensions(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const d = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return d;
  } catch {
    return { width: null, height: null };
  }
}

// Sends one photo; onProgress(0..1). Resolves to { id, width, height }.
export async function uploadPhoto(postId, file, position, onProgress) {
  const { width, height } = await dimensions(file);
  const auth = await token();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${GATEWAY}/posts/${postId}/photos`);
    xhr.setRequestHeader('authorization', `Bearer ${auth}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    if (width) xhr.setRequestHeader('x-width', String(width));
    if (height) xhr.setRequestHeader('x-height', String(height));
    xhr.setRequestHeader('x-position', String(position));
    if (file.lastModified) xhr.setRequestHeader('x-taken-at', new Date(file.lastModified).toISOString());
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error(navigator.onLine ? 'Couldn’t reach the photo store. It may be offline.' : 'You’re offline.'));
    xhr.send(file);
  });
}

// Upload several, one at a time (kinder to a home connection), reporting overall progress.
export async function uploadAll(postId, files, onProgress, startAt = 0) {
  const results = [];
  for (let i = 0; i < files.length; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push({ ok: true, photo: await uploadPhoto(postId, files[i], startAt + i, (p) => onProgress?.((i + p) / files.length, i)) });
    } catch (e) {
      results.push({ ok: false, file: files[i], error: e.message });
    }
  }
  onProgress?.(1, files.length);
  return results;
}
