import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { sendQueued } from './data.js';
import * as queue from './lib/outbox.js';
import { notifyChanged, useOnline } from './hooks.js';

const Ctx = createContext(null);
export const useOutbox = () => useContext(Ctx);

// Everything the person writes goes through here: it is sent straight away when online, and parked
// on the device (then sent automatically later) when there is no connection.
export function OutboxProvider({ children }) {
  const [items, setItems] = useState([]);
  const [settled, setSettled] = useState([]); // sent, but the timeline may not have reloaded yet
  const online = useOnline();

  const settle = useCallback((entries) => {
    const stamped = entries.map((e) => ({ ...e, queuedAt: e.queuedAt || Date.now() }));
    setSettled((s) => [...s, ...stamped]);
    setTimeout(() => setSettled((s) => s.filter((e) => !stamped.some((x) => x.id === e.id))), 8000);
  }, []);

  const refresh = useCallback(async () => setItems(await queue.list()), []);

  const flush = useCallback(async () => {
    const { sent, sentItems, items: left } = await queue.flush(sendQueued);
    if (sent > 0) { settle(sentItems); notifyChanged(); }
    setItems(left);
  }, [settle]);

  useEffect(() => { flush(); }, [flush]);
  useEffect(() => { if (online) flush(); }, [online, flush]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') flush(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [flush]);

  const submit = useCallback(async (entry) => {
    if (navigator.onLine) {
      const { error } = await sendQueued(entry);
      if (!error || error.code === '23505') { settle([entry]); notifyChanged(); return { ok: true }; }
      // A real rejection (not allowed, too long...) goes back to the person instead of waiting forever.
      if (!queue.isNetworkError(error)) return { ok: false, error: error.message };
    }
    setItems(await queue.enqueue(entry));
    return { ok: true, queued: true };
  }, [settle]);

  const retry = useCallback(async (id) => {
    const all = await queue.list();
    await queue.remove(id);
    const entry = all.find((i) => i.id === id);
    if (entry) { const { failed, ...rest } = entry; await queue.enqueue(rest); }
    await flush();
  }, [flush]);

  const discard = useCallback(async (id) => { await queue.remove(id); await refresh(); }, [refresh]);

  const value = useMemo(() => ({ items, settled, submit, retry, discard }), [items, settled, submit, retry, discard]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
