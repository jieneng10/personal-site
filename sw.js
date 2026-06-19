/**
 * Service Worker — 三层离线缓存策略
 *
 * 【策略说明】
 *   ① 核心文件（HTML/CSS/JS/JSON）— Cache-First
 *     安装时立即缓存，后续优先使用缓存，后台更新。
 *     保障离线可用，首屏秒开。
 *
 *   ② 大文件（BGM/壁纸）— Network-First
 *     优先从网络获取新鲜版本，网络失败时回退到缓存。
 *     避免安装时一次性下载 30MB+ 的音频文件。
 *
 *   ③ Supabase API — 永不缓存
 *     数据请求永远走网络，确保内容实时。
 *
 * 【缓存版本命名】
 *   ASSETS 列表由 scripts/build.js 自动生成并替换。
 *   每次构建版本号自动递增，旧缓存被 activate 事件清除。
 */

var CACHE_CORE = 'ps-core-v11';   // 核心文件（Cache-First）
var CACHE_MEDIA = 'ps-media-v11'; // 大文件（Network-First）

// 核心文件列表——构建脚本构建时自动替换
var ASSETS = [
  '/personal-site/',
  '/personal-site/index.html',
  '/personal-site/admin.html',
  '/personal-site/404.html',
  '/personal-site/feed.xml',
  '/personal-site/manifest.json',
  '/personal-site/css/variables.css',
  '/personal-site/css/layout.css',
  '/personal-site/css/components.css',
  '/personal-site/css/responsive.css',
  '/personal-site/js/shared.js',
  '/personal-site/js/event-bus.js',
  '/personal-site/js/cache.js',
  '/personal-site/js/supabase.js',
  '/personal-site/js/marked.min.js',
  '/personal-site/js/admin.js',
  '/personal-site/js/sakura.js',
  '/personal-site/js/articles.js',
  '/personal-site/js/wallpaper.js',
  '/personal-site/js/bgm.js',
  '/personal-site/js/cloud.js',
  '/personal-site/js/settings.js',
  '/personal-site/js/nav.js',
  '/personal-site/js/main.js',
  '/personal-site/data/articles.json',
  '/personal-site/data/anime-news.json',
  '/personal-site/js/anime-news.js',
  '/personal-site/static/images/default-avatar.png',
  '/personal-site/static/wallpapers/1.webp',
  '/personal-site/static/wallpapers/2.webp',
  '/personal-site/static/wallpapers/3.webp',
  '/personal-site/static/wallpapers/4.webp',
  '/personal-site/static/wallpapers/5.webp',
  '/personal-site/static/wallpapers/6.webp',
  '/personal-site/static/bgm/desir.mp3',
  '/personal-site/static/bgm/snow.mp3',
  '/personal-site/static/bgm/riya_one.mp3',
];

// ─── 大文件（Network-First）路径模式 ───
var MEDIA_PATTERNS = [/\/bgm\//, /\/wallpapers\//];

// ═══════════════════════════════════════════════════════════
// Install — 只预缓存核心文件
// ═══════════════════════════════════════════════════════════

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_CORE).then(function(cache) {
      // 只缓存非媒体文件
      var coreAssets = ASSETS.filter(function(a) {
        return !MEDIA_PATTERNS.some(function(re) { return re.test(a); });
      });
      return cache.addAll(coreAssets).catch(function() {});
    })
  );
  self.skipWaiting();
});

// ═══════════════════════════════════════════════════════════
// Activate — 清除旧版本缓存
// ═══════════════════════════════════════════════════════════

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) {
          return k !== CACHE_CORE && k !== CACHE_MEDIA;
        }).map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// ═══════════════════════════════════════════════════════════
// Fetch — 按文件类型选择缓存策略
// ═══════════════════════════════════════════════════════════

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  // ③ Supabase API — 永不缓存
  if (e.request.url.includes('supabase.co')) return;

  // 判断是否为大文件（BGM/壁纸）
  var isMedia = MEDIA_PATTERNS.some(function(re) { return re.test(e.request.url); });

  if (isMedia) {
    // ② Network-First：大文件优先用网络
    e.respondWith(
      fetch(e.request).then(function(res) {
        // 网络成功 → 更新缓存（后台）
        if (res && res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE_MEDIA).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        // 网络失败 → 回退到缓存
        return caches.match(e.request);
      })
    );
  } else {
    // ① Cache-First：核心文件优先用缓存
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        var fetched = fetch(e.request).then(function(res) {
          // 网络成功 → 更新缓存（后台静默）
          if (res && res.status === 200) {
            var clone = res.clone();
            caches.open(CACHE_CORE).then(function(c) { c.put(e.request, clone); });
          }
          return res;
        }).catch(function() {
          // 网络失败 → 返回缓存或离线提示
          return cached || new Response('Offline', { status: 503 });
        });
        return cached || fetched;
      })
    );
  }
});
