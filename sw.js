// holoVault Service Worker
// Strategy:
//   - App shell (HTML, manifest, fonts): cache-first with background refresh
//   - Archive JSON data: conditional network fetch (ETag/304 — free when unchanged)
//   - Product images (R2): cache-first (URLs are immutable)
//   - Everything else: network-first with cache fallback

const SHELL_CACHE = 'holovault-shell-v2';
const DATA_CACHE  = 'holovault-data-v2';
const IMG_CACHE   = 'holovault-img-v2';

// App shell — cached on install for offline use
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json'
];

const R2_DOMAIN       = 'pub-0298b2301e1648378bb71f8c2d22c63b.r2.dev';
const ARCHIVE_PATTERN = new RegExp(R2_DOMAIN.replace('.', '\\.') + '.*\\.json');
const CDN_IMG_PATTERN = new RegExp(R2_DOMAIN.replace('.', '\\.') + '.*\\.webp');
const FONT_PATTERN    = /fonts\.(googleapis|gstatic)\.com/;

const MAX_IMG_COUNT = 5000; // max images to keep in cache (FIFO)

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

  // R2 JSON archive — conditional fetch (sends ETag; 304 is free, 200 updates cache)
  if (ARCHIVE_PATTERN.test(url)) {
    event.respondWith(conditionalFetch(event.request, DATA_CACHE));
    return;
  }

  // R2 images — cache-first (immutable URLs, no Class B calls on revisit)
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

// Conditional fetch: sends If-None-Match (ETag) so R2 can return 304 (free)
// when the JSON hasn't changed. On 200, updates cache and returns fresh response.
// On 304, returns the cached response directly. Falls back to cache if offline.
async function conditionalFetch(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Build a conditional request if we have a cached ETag
  let condRequest = request;
  if (cached) {
    const etag = cached.headers.get('ETag');
    if (etag) {
      condRequest = new Request(request.url, {
        headers: { 'If-None-Match': etag }
      });
    }
  }

  try {
    const resp = await fetch(condRequest);

    if (resp.status === 304) {
      // Not modified — serve from cache (no Class B charge)
      return cached;
    }

    if (resp.ok) {
      // New content — update cache and return fresh response
      await cache.put(request, resp.clone());
      return resp;
    }

    // Unexpected non-ok response — fall back to cache if available
    return cached || resp;
  } catch {
    // Offline — serve cache
    return cached || new Response('Offline', { status: 503 });
  }
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        // resp.status === 0 handles opaque cross-origin responses (e.g. R2 images),
        // which Firefox correctly marks as non-ok per spec even when the fetch succeeded.
        if (resp.ok || resp.status === 0) {
          cache.put(request, resp.clone());
          if (cacheName === IMG_CACHE) trimCache(IMG_CACHE);
        }
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

// ── Cache count trim (count-based, FIFO) ─────────────────────────────────────
async function trimCache(cacheName) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length <= MAX_IMG_COUNT) return;

  // Delete oldest entries until we're back under the limit
  const toDelete = keys.slice(0, keys.length - MAX_IMG_COUNT);
  await Promise.all(toDelete.map(key => cache.delete(key)));
}
