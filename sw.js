/* Service worker: app shell cached for offline use, schedule data kept fresh.

   Bump APP_VERSION whenever you change any shell file — the cache name derives
   from it, so a new version installs cleanly and the old one is swept away. */

const APP_VERSION = '1.10.1';
const SHELL_CACHE = `gel7-shell-${APP_VERSION}`;
const DATA_CACHE = 'gel7-data';
const DATA_TIMEOUT_MS = 3000;
// An update check (app.js adds ?check=1) is the student asking the network
// itself, so it gets longer before the kept copy answers instead.
const CHECK_TIMEOUT_MS = 10000;

/* Without these the app cannot open offline at all, so they are all or
   nothing: one that fails fails the install, and the browser tries again on a
   later visit rather than activating a worker that cannot do its one job. */
const CORE = ['./', 'index.html', 'app.css', 'app.js'];

const SHELL = [
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
    // 'no-cache' asks the server every time, so a new version never caches a
    // stale file, but anything unchanged — the files the page itself loaded a
    // moment ago on a first visit, the icons on every update — comes back as a
    // header-only 304. 'reload' downloaded all of it again: 82 KB for a first
    // install instead of ~40.
    await cache.addAll(CORE.map((url) => new Request(url, { cache: 'no-cache' })));
    // A missing icon must not fail the whole install, so add these one by one.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'no-cache' })).catch(() => {})));
    // Seed the data cache so the very first offline open still has a timetable.
    const data = await caches.open(DATA_CACHE);
    await data.add(new Request('data/schedule.json', { cache: 'no-cache' })).catch(() => {});
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
function networkFirst(event) {
  const url = new URL(event.request.url);
  const check = url.searchParams.has('check');
  // Fetched and kept without the marker, so a check and a first load share
  // one copy here and one entry in the browser's HTTP cache.
  url.searchParams.delete('check');
  // 'no-cache' revalidates but lets an unchanged file answer from the HTTP
  // cache, so a repeat check transfers headers only.
  const network = fetch(url.href, { cache: 'no-cache' }).then((response) => {
    if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
    return { response, kept: caches.open(DATA_CACHE).then((c) => c.put(url.href, response.clone())) };
  });
  // The race below only decides what the page gets now. A copy that arrives
  // after it still goes into the cache for the next open; throwing it away
  // left a student on slow Wi-Fi on the old schedule however long they waited.
  event.waitUntil(network.then((got) => got.kept).catch(() => {}));
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), check ? CHECK_TIMEOUT_MS : DATA_TIMEOUT_MS));
  return Promise.race([network, timeout])
    .then((got) => got.response)
    .catch(async (err) => {
      const cache = await caches.open(DATA_CACHE);
      const cached = await cache.match(url.href, { ignoreSearch: true });
      if (cached) return labelledStale(cached);
      throw err;
    });
}

/** The cached copy, marked as one. Unmarked, a fallback is indistinguishable
    from a fresh 200 to the page, so «Έλεγχος για νέο πρόγραμμα» with no signal
    at all reported «ενημερωμένο» — and throttled the next real check. app.js
    looks for this header on update checks and treats it as being offline. */
function labelledStale(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Served-From', 'cache');
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
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
    event.respondWith(networkFirst(event));
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
