/* Service worker: app shell cached for offline use, schedule data kept fresh.

   Bump APP_VERSION whenever you change any shell file — the cache name derives
   from it, so a new version installs cleanly and the old one is swept away. */

const APP_VERSION = '1.5.0';
const SHELL_CACHE = `gel7-shell-${APP_VERSION}`;
const DATA_CACHE = 'gel7-data';
const DATA_TIMEOUT_MS = 3000;

const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One bad URL must not fail the whole install, so add them individually.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    // Seed the data cache so the very first offline open still has a timetable.
    const data = await caches.open(DATA_CACHE);
    await data.add(new Request('data/schedule.json', { cache: 'reload' })).catch(() => {});
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('gel7-shell-') && n !== SHELL_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Network first with a short timeout, falling back to the cached copy.
    Used for schedule data: fresh when there is signal, instant when there isn't. */
async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await Promise.race([
      // 'no-cache' revalidates but lets an unchanged file answer from the HTTP
      // cache, so a repeat check transfers headers only.
      fetch(request, { cache: 'no-cache' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DATA_TIMEOUT_MS)),
    ]);
    if (response && response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    throw new Error(`HTTP ${response && response.status}`);
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && request.method === 'GET') {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('.json') && !url.pathname.endsWith('manifest.webmanifest')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // A navigation to any in-scope URL should open the app shell, so deep links
  // and the `?now=` debug parameter still work offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      cacheFirst(new Request('index.html'))
        .catch(() => caches.match('./'))
    );
    return;
  }

  event.respondWith(cacheFirst(request).catch(() => caches.match(request)));
});
