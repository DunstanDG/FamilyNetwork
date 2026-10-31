/* eslint-env serviceworker */
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';

const BASE = import.meta.env.BASE_URL;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// The app shell works offline. API calls are never cached here: the app keeps its own timeline cache.
registerRoute(new NavigationRoute(createHandlerBoundToURL(`${BASE}index.html`)));

// Avatars and thumbnails (cross-origin images come back "opaque", status 0).
registerRoute(
  ({ request }) => request.destination === 'image',
  new StaleWhileRevalidate({
    cacheName: 'images',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* plain-text push */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Family Network', {
      body: data.body || '',
      icon: `${BASE}icon-192.png`,
      badge: `${BASE}icon-192.png`,
      tag: data.tag,
      data: { postId: data.postId || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const postId = event.notification.data?.postId;
  const target = `${BASE}${postId ? `?post=${encodeURIComponent(postId)}` : ''}`;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(self.location.origin + BASE));
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open-post', postId });
    } else {
      await self.clients.openWindow(target);
    }
  })());
});
