// Service worker mínimo: permite instalar la app y abrirla aunque la señal sea mala.
// Estrategia: red primero y, si no hay conexión, la última copia guardada. Supabase nunca se cachea.
const CACHE = 'gdo-v1';
const BASE = ['inspector.html', 'css/inspector.css', 'js/inspector.js', 'js/config.js', 'manifest.json', 'img/icono-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('supabase.co')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (u.origin === location.origin || u.hostname.includes('jsdelivr'))) {
      const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia));
    }
    return r;
  }).catch(() => caches.match(e.request)));
});
