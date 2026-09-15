// Service Worker — 荧光检测平台
// 策略：同源资源「网络优先 + 缓存回退」，跨域资源「缓存优先」
// 网络优先保证每次推送的新代码立即生效，离线时自动回退到缓存

const CACHE_NAME = 'fluorescence-v2';

// 需要预缓存的所有静态资源
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/constants.js',
  './js/ui.js',
  './js/utif.js',
  './js/storage.js',
  './js/camera.js',
  './js/roi.js',
  './js/imageProc.js',
  './js/pseudocolor.js',
  './js/results.js',
  './js/app.js',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-1024.png'
];

// ====== Install：预缓存所有静态资源 ======
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pre-caching assets');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => {
        console.log('[SW] Pre-cache complete');
        return self.skipWaiting();
      })
      .catch(err => {
        // 某些资源（如图标）可能尚未创建，不阻塞安装
        // 运行时仍会按需缓存
        console.warn('[SW] Pre-cache partial failure:', err.message);
      })
  );
});

// ====== Activate：清理旧版本缓存 ======
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] Now controlling all clients');
      return self.clients.claim();
    })
  );
});

// ====== 工具：将网络响应写入缓存 ======
function putInCache(request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque') return;
  const copy = response.clone();
  caches.open(CACHE_NAME).then(cache => {
    cache.put(request, copy);
  });
}

// ====== Fetch ======
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只处理 GET 请求
  if (request.method !== 'GET') return;

  // 跳过 chrome-extension 等非 http(s) 请求
  if (!request.url.startsWith('http')) return;

  const isSameOrigin = new URL(request.url).origin === self.location.origin;

  // ---- 跨域资源（CDN 等）：缓存优先，减少对外网依赖 ----
  if (!isSameOrigin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          putInCache(request, response);
          return response;
        });
      })
    );
    return;
  }

  // ---- 同源资源：网络优先，保证新版本立即生效；离线时回退到缓存 ----
  event.respondWith(
    fetch(request)
      .then(response => {
        putInCache(request, response);
        return response;
      })
      .catch(() => {
        return caches.match(request).then(cached => {
          if (cached) return cached;

          // 完全离线且无缓存 —— HTML 导航请求回退到首页
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }

          // 其他资源静默失败
          return new Response('', { status: 408 });
        });
      })
  );
});
