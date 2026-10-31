// Posts and comments written while offline wait here and are sent when the connection returns.
// Each entry carries a client-made id, so sending twice can never create a duplicate.
import { get, set } from './idb.js';

const KEY = 'outbox';

export const list = async () => (await get(KEY)) || [];
const save = (items) => set(KEY, items);

export async function enqueue(entry) {
  const items = await list();
  if (!items.some((i) => i.id === entry.id)) items.push({ ...entry, queuedAt: Date.now() });
  await save(items);
  return items;
}

export async function remove(id) {
  await save((await list()).filter((i) => i.id !== id));
}

async function markFailed(id, message) {
  await save((await list()).map((i) => (i.id === id ? { ...i, failed: message || 'Could not be sent' } : i)));
}

export function isNetworkError(error) {
  if (!error) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return error.status === 0 || /failed to fetch|network|load failed|timeout/i.test(`${error.message || ''}`);
}

export function isAuthError(error) {
  return Boolean(error) && (error.status === 401 || error.code === 'PGRST301' || /jwt/i.test(error.message || ''));
}

let inFlight = null;

// `send(entry)` resolves to { error } like a Supabase call. Entries are sent in order; a network or
// sign-in problem stops the run (and keeps everything), anything else marks just that entry failed.
export function flush(send) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let sent = 0;
    const sentItems = [];
    for (const item of await list()) {
      if (item.failed) continue;
      let res;
      try { res = await send(item); } catch (e) { res = { error: e }; }
      const error = res?.error;
      if (!error || error.code === '23505') { await remove(item.id); sent += 1; sentItems.push(item); continue; }
      if (isNetworkError(error) || isAuthError(error)) break;
      await markFailed(item.id, error.message);
    }
    return { sent, sentItems, items: await list() };
  })().finally(() => { inFlight = null; });
  return inFlight;
}
