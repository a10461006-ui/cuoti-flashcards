// 離線支援：第一次開啟就把整個 App 存起來，之後沒有網路也能使用。
// 策略是「網路優先」：有網路時永遠拿最新版本，離線才用快取。PDF 函式庫第一次使用時才快取。
const CACHE = 'fc-aaf1930ae4';
const SHELL = [
  './',
  'css/app.css',
  'js/config.js', 'js/boot.js', 'js/app.js', 'js/api.js', 'js/ui.js', 'js/store.js', 'js/google.js',
  'js/local/errors.js', 'js/local/textutil.js', 'js/local/zip.js', 'js/local/xlsx.js', 'js/local/importer.js',
  'js/local/exam.js', 'js/local/srs.js', 'js/local/db.js', 'js/local/api.js',
  'js/views/home.js', 'js/views/practice.js', 'js/views/bank.js', 'js/views/question.js', 'js/views/editor.js',
  'js/views/import.js', 'js/views/add.js', 'js/views/papers.js', 'js/views/paper_upload.js', 'js/views/paper.js',
  'js/views/stats.js', 'js/views/settings.js', 'js/views/login.js', 'js/views/setup.js',
  'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((hit) => hit || (event.request.mode === 'navigate' ? caches.match('./') : undefined))
        .then((hit) => hit || new Response('離線中，這個檔案還沒有存到這台裝置', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))),
  );
});
