const CACHE = 'mlbag-v1';
const SHELL = ['/index.html', '/styles.css', '/main.js', '/icon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Pass through API calls and proxied requests to the network
  if (url.includes('statsapi.mlb') || url.includes('fonts.goog') ||
      url.includes('/proxy/') || url.includes('baseballsavant')) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
