/* Exercises sw.js in a mock ServiceWorkerGlobalScope.
   The in-app preview pane cannot register service workers, so the caching
   strategies are verified here instead of in a browser.

     node tools/test/sw.test.mjs
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://example.test';

/* ------------------------------------------------------------- mock caches */

class MockCache {
  constructor() { this.store = new Map(); }
  key(req) { return new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname; }
  async put(req, res) { this.store.set(this.key(req), res); }
  async add(req) {
    const res = await mockFetch(req);
    if (!res.ok) throw new Error('add failed');
    this.store.set(this.key(req), res);
  }
  async match(req) { return this.store.get(this.key(req)); }
}

class MockCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MockCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
  async match(req) {
    for (const c of this.caches.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

/* ------------------------------------------------------------- mock network */

let network = { online: true, delayMs: 0, body: 'v1' };

async function mockFetch(req) {
  const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN);
  if (!network.online) throw new TypeError('Failed to fetch');
  if (network.delayMs) await new Promise((r) => setTimeout(r, network.delayMs));
  return {
    ok: true, status: 200, url: url.href, _body: network.body,
    clone() { return { ...this, clone: () => this }; },
  };
}

/* --------------------------------------------------------------- run sw.js */

const listeners = new Map();
const self = {
  location: new URL('/sw.js', ORIGIN),
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  skipWaiting: async () => { self._skipped = true; },
  clients: { claim: async () => { self._claimed = true; } },
};

class MockRequest {
  constructor(url, init = {}) {
    this.url = new URL(typeof url === 'string' ? url : url.url, ORIGIN).href;
    this.method = init.method || 'GET';
    this.mode = init.mode || 'no-cors';
  }
}

const sandbox = {
  self, caches: new MockCacheStorage(), fetch: mockFetch,
  URL, Request: MockRequest,
  setTimeout, clearTimeout, Promise, Error, console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(root, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });

/* ------------------------------------------------------------------- helpers */

async function dispatch(type, event) {
  const waits = [];
  const respondsWith = [];
  const ev = {
    ...event,
    waitUntil: (p) => waits.push(p),
    respondWith: (p) => respondsWith.push(p),
  };
  for (const fn of listeners.get(type) || []) await fn(ev);
  await Promise.all(waits);
  return respondsWith.length ? respondsWith[0] : undefined;
}

const request = (path, extra = {}) =>
  ({ url: `${ORIGIN}${path}`, method: 'GET', mode: 'no-cors', ...extra });

/* ---------------------------------------------------------------- the tests */

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message}`]); }
}

await test('APP_VERSION matches between app.js and sw.js', async () => {
  // The shell cache is keyed on sw.js's APP_VERSION, and app.js prints its own
  // in the footer. If they drift, the footer lies about which build is live and
  // a shell change can ship without busting the cache.
  const read = (file) => {
    const src = readFileSync(resolve(root, file), 'utf8');
    const m = src.match(/APP_VERSION\s*=\s*'([^']+)'/);
    assert.ok(m, `no APP_VERSION in ${file}`);
    return m[1];
  };
  assert.equal(read('app.js'), read('sw.js'),
    'bump APP_VERSION in BOTH app.js and sw.js when you change a shell file');
});

await test('install precaches the shell and seeds the schedule', async () => {
  await dispatch('install', {});
  const names = await sandbox.caches.keys();
  assert.ok(names.some((n) => n.startsWith('gel7-shell-')), 'shell cache created');
  assert.ok(names.includes('gel7-data'), 'data cache created');

  const shell = await sandbox.caches.open(names.find((n) => n.startsWith('gel7-shell-')));
  for (const path of ['/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest']) {
    assert.ok(await shell.match(path), `precached ${path}`);
  }
  const data = await sandbox.caches.open('gel7-data');
  assert.ok(await data.match('/data/schedule.json'), 'schedule seeded for first offline open');
});

await test('activate sweeps caches from older app versions', async () => {
  await sandbox.caches.open('gel7-shell-0.0.1');   // a stale build
  await dispatch('activate', {});
  const names = await sandbox.caches.keys();
  assert.ok(!names.includes('gel7-shell-0.0.1'), 'old shell cache deleted');
  assert.ok(names.some((n) => n.startsWith('gel7-shell-')), 'current shell kept');
  assert.ok(self._claimed, 'claimed open pages');
});

await test('schedule.json is served from the network when online', async () => {
  network = { online: true, delayMs: 0, body: 'v2' };
  const res = await dispatch('fetch', { request: request('/data/schedule.json') });
  assert.equal((await res)._body, 'v2', 'fresh copy wins');
});

await test('schedule.json falls back to cache when offline', async () => {
  network = { online: false, delayMs: 0, body: 'unused' };
  const res = await dispatch('fetch', { request: request('/data/schedule.json') });
  assert.equal((await res)._body, 'v2', 'serves the last good copy');
});

await test('a slow network does not stall the schedule fetch', async () => {
  network = { online: true, delayMs: 5000, body: 'too-slow' };
  const started = Date.now();
  const res = await dispatch('fetch', { request: request('/data/schedule.json') });
  const body = (await res)._body;
  const elapsed = Date.now() - started;
  assert.equal(body, 'v2', 'times out to the cached copy');
  assert.ok(elapsed < 4000, `fell back after ${elapsed}ms, not the full 5s`);
});

await test('shell assets are served from cache while offline', async () => {
  network = { online: false, delayMs: 0, body: '' };
  const res = await dispatch('fetch', { request: request('/app.css') });
  assert.ok(await res, 'app.css served offline');
});

await test('an offline navigation still opens the app shell', async () => {
  network = { online: false, delayMs: 0, body: '' };
  const res = await dispatch('fetch', { request: request('/?now=2026-09-16T10:20', { mode: 'navigate' }) });
  assert.ok(await res, 'navigation resolved from cache');
});

await test('cross-origin requests are left alone', async () => {
  const res = await dispatch('fetch', { request: { url: 'https://other.test/x.js', method: 'GET' } });
  assert.equal(res, undefined, 'no respondWith for a foreign origin');
});

await test('SKIP_WAITING activates the waiting worker', async () => {
  await dispatch('message', { data: { type: 'SKIP_WAITING' } });
  assert.ok(self._skipped, 'skipWaiting called');
});

/* ------------------------------------------------------------------- report */

let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
