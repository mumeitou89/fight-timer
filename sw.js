/* リングタイマー Service Worker (オフライン対応)
 * 方針: キャッシュ優先で即表示 → 裏でネットから最新を取って次回に反映 (stale-while-revalidate)
 * audio/ 以下の録音ファイルも一度読み込めば自動でキャッシュされる。
 * アプリを大きく変えたときは CACHE の番号を上げると古いキャッシュが消える。
 */
var CACHE = 'ring-timer-v1.0.0';
var CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
      if (hit) {
        net.catch(function () {});   // 裏で更新(失敗しても無視)
        return hit;
      }
      return net;
    })
  );
});
