// Service Worker — 荧光检测平台
// 缓存优先策略，支持离线使用

const CACHE_NAME = 'fluorescence-v1';

// 需要预缓存的所有静态资源
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/constants.js',
  './js/ui.js',
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
  './icons/icon-512.png'
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

// ====== Fetch：缓存优先策略 ======
self.addEventListener('fetch', (event) => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;

  // 跳过 chrome-extension 等非 http(s) 请求
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        // 缓存命中，直接返回
        return cachedResponse;
      }

      // 缓存未命中，请求网络
      return fetch(event.request).then(networkResponse => {
        // 将网络响应加入缓存（仅缓存成功响应）
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 网络不可用且缓存未命中 —— 对于 HTML 页面返回离线提示
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html');
        }
        // 其他资源静默失败
        return new Response('', { status: 408 });
      });
    })
  );
});
