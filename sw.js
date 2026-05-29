const CACHE_NAME = 'lis-v1';
const urlsToCache = [
  'login.html',
  'accession.html',
  'result_entry.html',
  'management1.html',
  'management.html',
  'pending_portal.html',
  'style.css' // if you have a global CSS file; otherwise list each inline style?
];

// Install event – cache core files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Fetch event – serve from cache if available, else network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});