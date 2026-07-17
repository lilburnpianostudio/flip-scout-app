// sw.js — app-shell precache so Flip Scout launches offline (ADR-006).
const CACHE = 'flip-scout-shell-v17';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/ui.js',
  './js/githubStore.js',
  './js/store.js',
  './js/outbox.js',
  './js/ulid.js',
  './js/investigate.js',
  './js/inventory.js',
  './js/copywriter.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the shell; network passthrough for everything else
// (api.github.com is never cached — data freshness belongs to the mirror).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request))
    );
  }
});
