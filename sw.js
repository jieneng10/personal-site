// Service Worker — 离线缓存
var CACHE = 'ps-v5';
var ASSETS = [
  '/personal-site/',
  '/personal-site/index.html',
  '/personal-site/css/variables.css',
  '/personal-site/css/layout.css',
  '/personal-site/css/components.css',
  '/personal-site/css/responsive.css',
  '/personal-site/js/supabase-sdk.js',
  '/personal-site/js/supabase.js',
  '/personal-site/js/marked.min.js',
  '/personal-site/js/sakura.js',
  '/personal-site/js/articles.js',
  '/personal-site/js/wallpaper.js',
  '/personal-site/js/bgm.js',
  '/personal-site/js/cloud.js',
  '/personal-site/js/settings.js',
  '/personal-site/js/nav.js',
  '/personal-site/js/main.js',
  '/personal-site/data/articles.json',
  '/personal-site/images/default-avatar.png',
  '/personal-site/wallpapers/1.jpg',
  '/personal-site/wallpapers/2.jpg',
  '/personal-site/wallpapers/3.jpg',
  '/personal-site/bgm/desir.mp3',
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS).catch(function() {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  // 对 Supabase API 请求不缓存
  if (e.request.url.includes('supabase.co')) return;

  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var fetched = fetch(e.request).then(function(res) {
        if (res && res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return cached || new Response('Offline', { status: 503 });
      });
      return cached || fetched;
    })
  );
});
