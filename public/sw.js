/* Tournament Scoreboard service worker.
 *
 * Its only job is to make the interface survive a flaky WLAN: the shell is
 * cached so a phone that briefly loses the access point can still open the app
 * and reconnect. It never caches API or WebSocket traffic -- scores must always
 * come from the host, never from a stale cache.
 *
 * `__BUILD_ID__` below is replaced by the client build (see `stampServiceWorkerCache`
 * in vite.config.ts). `public/` is copied verbatim, so nothing inside the bundle
 * can know when a rebuild happened, which used to leave the cache name frozen in
 * the file: a browser that had already loaded the app kept rendering the previous
 * build out of the cache, and `activate` never deleted the entries for assets the
 * host had stopped serving. One cache name per build means exactly one
 * invalidation, and the message below lets an already-open screen reload onto it
 * instead of staying stale until someone hard-refreshes.
 */

const CACHE = 'tsb-shell-__BUILD_ID__';
const SHELL = ['/', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      // Tell every open screen that the build it is running has been replaced.
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => {
        for (const client of clients) client.postMessage({ type: 'tsb:new-build' });
      }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never serve live data or the service worker itself from the cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then((cached) => cached || new Response('Offline', { status: 503 })),
      ),
    );
    return;
  }

  // Stale-while-revalidate: answer from the cache immediately, but always go to
  // the network in the background so the next load is on the current build.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached || new Response('', { status: 504 }));
      return cached || network;
    }),
  );
});
