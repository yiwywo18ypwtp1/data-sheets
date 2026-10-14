/*
 * Service worker: lets a table opened before be opened again without a network.
 *
 * - Pages of tables (`/b/…`, and `/`): network first; each page that loads is kept, and
 *   offline the kept copy is served (it carries the first rows, rendered on the server).
 * - `/_next/static/…` (scripts, styles, fonts; their names change with every build):
 *   cache first.
 * - Everything else, including `/api/…` and the router's RSC requests, goes to the network
 *   untouched: row windows have their own offline copies in IndexedDB, and writes queue
 *   in IndexedDB while offline (see src/features/offline).
 *
 * Registered only by production builds (see ServiceWorkerRegistration.tsx).
 */

const VERSION = "v1";
const STATIC_CACHE = `static-${VERSION}`;
const PAGE_CACHE = `pages-${VERSION}`;
const MAX_PAGES = 40;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== STATIC_CACHE && key !== PAGE_CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === "navigate" && (url.pathname === "/" || url.pathname.startsWith("/b/"))) {
    event.respondWith(networkFirst(event));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    // Only complete pages: not redirects (`/` → the first view), not error pages. Saved in the
    // background, so the page still streams in instead of waiting for the copy.
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      event.waitUntil(cache.delete(request).then(() => cache.put(request, copy)).then(() => trim(cache)));
    }
    return response;
  } catch {
    // The same view with other query parameters (`?record=`) is better than nothing.
    const cached = (await cache.match(request)) ?? (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title>' +
        '<body style="font-family:system-ui;padding:2rem;color:#3f3f46"><h1 style="font-size:1.1rem">You are offline</h1>' +
        "<p>This page wasn't opened on this device before, so there is no saved copy. Tables you have opened are available offline.</p></body>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/** Keeps the newest MAX_PAGES pages (keys come back in insertion order; a page is re-inserted on each visit). */
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(key);
}
