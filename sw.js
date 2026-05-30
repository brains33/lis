/**
 * sw.js — MU'UJIZA LIS Service Worker
 * ═══════════════════════════════════════════════════════════════
 *
 * SECURITY RULE: Protected HTML pages are NEVER cached.
 * Caching authenticated pages means a logged-out user on a shared
 * device can open them offline and see the full page shell —
 * bypassing the auth guard entirely.
 *
 * Only truly static, public assets are cached:
 *   • login.html        — the only public-facing page
 *   • Static assets     — icons, manifest, fonts fallback
 *
 * All other requests (protected HTML, Supabase API calls) always
 * go to the network. If the network is unavailable, the browser
 * shows its default offline message rather than a stale page.
 * ═══════════════════════════════════════════════════════════════
 */

// Bump this version string whenever you deploy changes.
// The old cache will be deleted automatically on activation.
const CACHE_VERSION = 'lis-v3';

// Only these files are safe to serve from cache.
// DO NOT add accession.html, result_entry.html, management*.html,
// or pending_portal.html — those require a live auth check.
const STATIC_CACHE = [
  'login.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'auth-guard.js',
  'global.js',
];

// HTML pages that must ALWAYS be fetched from the network.
// Requests for these will never be served from cache.
const PROTECTED_PAGES = [
  'accession.html',
  'result_entry.html',
  'management.html',
  'management1.html',
  'pending_portal.html',
];

// ── Install: cache only static assets ───────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_CACHE))
      .then(() => self.skipWaiting()) // activate immediately, don't wait for old SW to die
  );
});

// ── Activate: delete any old cache versions ──────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

// ── Fetch: network-first for protected pages, cache-first for static ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const filename = url.pathname.split('/').pop();

  // 1. Supabase API calls — always network, never cache
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Protected HTML pages — always network, never cache
  //    If network fails, return a simple auth-required response
  //    rather than a stale cached page.
  if (PROTECTED_PAGES.includes(filename)) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          `<!DOCTYPE html><html><head><meta charset="UTF-8">
           <meta http-equiv="refresh" content="0;url=login.html">
           </head><body>
           <p>You are offline. <a href="login.html">Return to login</a>.</p>
           </body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        )
      )
    );
    return;
  }

  // 3. Static assets — cache-first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache successful same-origin responses
        if (
          response.ok &&
          response.type === 'basic' &&
          event.request.method === 'GET'
        ) {
          const toCache = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, toCache));
        }
        return response;
      });
    })
  );
});
