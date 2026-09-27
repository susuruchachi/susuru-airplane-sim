// sw.js — ホーム画面に追加して「アプリ」として開くためのサービスワーカー
//
// Android の Chrome は、マニフェスト（manifest.webmanifest）とこのサービスワーカーがあると
// 「アプリをインストール」を出し、ホーム画面から全画面で開けるようにする。
//
// **いつも新しいファイルを先に取りに行く**（ネットワーク優先）。キャッシュを先に使うと、
// 更新を push しても古い JS のまま動き続ける——この作品は毎日のように中身が変わるので、
// それがいちばん困る。つながらないときだけ、前に開いたときのファイルで動かす。
// three.js などの CDN のファイルも同じ扱いでキャッシュする（オフラインでも開けるように）。

const SW_CACHE = 'flight-sim-v1';

self.addEventListener('install', (event) => {
  // 入れ替えを待たずにすぐ使う
  self.skipWaiting();
  event.waitUntil(caches.open(SW_CACHE).then((c) => c.addAll(['./', './index.html', './flight.html'])
    .catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SW_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com';
  if (!sameOrigin && !cdn) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(SW_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
