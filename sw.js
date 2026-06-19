/**
 * sw.js — MU'UJIZA LIS Service Worker
 * ═══════════════════════════════════════════════════════════════
 *
 * All pages use stale-while-revalidate — no redirects ever.
 * When the device goes offline every page stays exactly where
 * it is. If a page has never been visited (no cache entry yet)
 * the browser shows its own "no connection" screen instead of
 * being pushed somewhere unexpected.
 *
 * Cache strategies:
 *   • Supabase API               → network-only  (always)
 *   • Everything else            → stale-while-revalidate
 *
 * Pages with full offline capability (shell + IndexedDB queue):
 *   • result_entry.html          — offline_queue.js handles writes, COC, test defs
 *   • accession.html             — offline registration queue, test def dropdowns
 *   • pending_portal.html        — all Released results cached with tests
 *   • management1.html           — verify/release queued offline, test defs cached
 *
 * Pages with read-only offline capability (cached shell only):
 *   • management.html / login.html
 * ═══════════════════════════════════════════════════════════════
 */

const CACHE_VERSION = 'lis-v9';

// ── Pre-cache on install ─────────────────────────────────────────
// All shared assets + every page shell so they're available from
// the very first offline moment, even before the user visits them.

// Shared local assets — hard requirement, install fails if missing
const STATIC_CACHE = [
  'login.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'auth-guard.js',
  'global.js',
  'offline_queue.js',
  'result_entry.js',
];

// Page shells — best-effort (large files; warn and continue if slow)
const PAGE_SHELLS = [
  'result_entry.html',
  'accession.html',
  'pending_portal.html',
  'management.html',
  'management1.html',
];

// CDN assets shared across pages — best-effort
const CDN_ASSETS = [
  // Fonts
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono&display=swap',
  'https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700&family=JetBrains+Mono:wght@500&display=swap',
  // Icons
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  // Scripts
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  // NOTE: Paystack's inline.js is intentionally NOT pre-cached here.
  // It's a third-party payment SDK that can change at any time; pinning
  // an old cached copy via stale-while-revalidate caused intermittent
  // "Attribute callback must be a valid function" failures that didn't
  // reproduce locally (no service worker there). It's now excluded from
  // caching entirely — see the network-only rule in the fetch handler.
  // Font Awesome webfonts (needed for icons to render offline)
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2',
];

// ── Install ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async cache => {
      // Local static files — must all succeed
      await cache.addAll(STATIC_CACHE);

      // Page shells + CDN assets — best-effort, warn on individual failures
      const bestEffort = [...PAGE_SHELLS, ...CDN_ASSETS];
      await Promise.allSettled(
        bestEffort.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] pre-cache skipped:', url, err)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase API — always network, never cache.
  // offline_queue.js handles write buffering for result_entry.
  // Paystack's inline.js — also always network. It's a live payment SDK;
  // serving a stale cached copy caused "Attribute callback must be a
  // valid function" errors that only showed up on deployed devices.
  if (url.hostname.includes('supabase.co') || url.hostname.includes('paystack')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Everything else — stale-while-revalidate.
  // Cached copy served instantly with no network wait; fresh copy
  // fetched in the background and stored for next time.
  // No page is ever redirected away due to a network failure.
  event.respondWith(staleWhileRevalidate(event.request));
});

// ── Helper: stale-while-revalidate ───────────────────────────────
// 1. Return cached copy immediately (fast, works offline).
// 2. Fetch a fresh copy in the background; update cache silently.
// 3. If nothing cached AND network is down: return 503 (browser
//    shows its own offline UI — no forced redirect).
async function staleWhileRevalidate(request) {
  // Only cache GET requests; POST/PUT pass straight through
  if (request.method !== 'GET') {
    return fetch(request);
  }

  const cache  = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  // Background network refresh — always attempted, never blocks the response
  const networkFetch = fetch(request)
    .then(response => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null); // offline — silent, cached copy takes over

  // Serve cached instantly; fall back to network if not yet cached
  return cached || networkFetch || new Response('', { status: 503 });
}
