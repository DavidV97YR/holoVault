// holoVault Service Worker
// Strategy:
//   - App shell (HTML, manifest, fonts): cache-first with background refresh
//   - Archive JSON data: stale-while-revalidate (instant load, fresh in background)
//   - Product images (CDN): cache-first (URLs are immutable)
//   - Everything else: network-first with cache fallback

const SHELL_CACHE = 'holovault-shell-v1';
const DATA_CACHE  = 'holovault-data-v1';
const IMG_CACHE   = 'holovault-img-v1';

// App shell — cached on install for offline use
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json'
];

const ARCHIVE_PATTERN = /raw\.githubusercontent\.com.*products\.json/;
const CDN_IMG_PATTERN = /cdn\.shopify\.com\/s\/files/;
const FONT_PATTERN    = /fonts\.(googleapis|gstatic)\.com/;

// ── Install: pre-cache app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete outdated caches ─────────────────────────────────────────
self.addEventListener('activate', event => {
  const valid = new Set([SHELL_CACHE, DATA_CACHE, IMG_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !valid.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route by request type ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Archive JSON — stale-while-revalidate (show cached instantly, refresh behind)
  if (ARCHIVE_PATTERN.test(url)) {
    event.respondWith(staleWhileRevalidate(event.request, DATA_CACHE));
    return;
  }

  // Shopify CDN images — cache-first (immutable URLs)
  if (CDN_IMG_PATTERN.test(url)) {
    event.respondWith(cacheFirst(event.request, IMG_CACHE));
    return;
  }

  // Google Fonts — cache-first
  if (FONT_PATTERN.test(url)) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    return;
  }

  // App shell / navigation — cache-first with background refresh
  if (event.request.mode === 'navigate' ||
      SHELL_FILES.some(f => url.includes(f))) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    return;
  }

  // Everything else — network-first, cache fallback
  event.respondWith(networkFirst(event.request, SHELL_CACHE));
});

// ── Caching strategies ───────────────────────────────────────────────────────

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      const fresh = fetch(request)
        .then(resp => {
          if (resp.ok) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        if (resp.ok) cache.put(request, resp.clone());
        return resp;
      });
    })
  );
}

function networkFirst(request, cacheName) {
  return fetch(request)
    .then(resp => {
      if (resp.ok) {
        caches.open(cacheName).then(cache => cache.put(request, resp.clone()));
      }
      return resp;
    })
    .catch(() => caches.match(request));
}
