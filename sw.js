const CACHE_NAME = 'almanac-shell-v49';
const APP_ASSETS = [
  './',
  './index.html',
  './src/index.html',
  './src/style.css',
  './src/app.js',
  './src/models.js',
  './src/keyword-engine.js',
  './src/fieldcraft-engine.js',
  './src/keyword-audit.js',
  './src/recipe-catalog.js',
  './src/catalog-adapters.js',
  './src/data/Flora.json',
  './src/data/Fauna.json',
  './src/data/Recipes.json',
  './public/manifest.json',
  './public/icons/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('almanac-shell-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(error => {
        if (event.request.mode === 'navigate') {
          return caches.match('./src/index.html').then(fallback => {
            if (fallback) return fallback;
            throw error;
          });
        }
        throw error;
      });
    })
  );
});
