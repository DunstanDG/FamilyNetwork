import { useEffect, useState } from 'react';

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

// Something the app wrote (a post, a reply, a pin) - lists listen for this and refresh.
export const notifyChanged = () => window.dispatchEvent(new Event('fn:changed'));

export function useOnChanged(callback) {
  useEffect(() => {
    window.addEventListener('fn:changed', callback);
    return () => window.removeEventListener('fn:changed', callback);
  }, [callback]);
}

// Chrome/Android/ChromeOS offer an install prompt we can trigger from our own button.
export function useInstallPrompt() {
  const [event, setEvent] = useState(() => window.__fnInstallEvent || null);
  useEffect(() => {
    const handler = () => setEvent(window.__fnInstallEvent || null);
    window.addEventListener('fn:installable', handler);
    return () => window.removeEventListener('fn:installable', handler);
  }, []);
  const install = async () => {
    if (!event) return false;
    event.prompt();
    const { outcome } = await event.userChoice;
    window.__fnInstallEvent = null;
    setEvent(null);
    return outcome === 'accepted';
  };
  return { canInstall: Boolean(event), install };
}
