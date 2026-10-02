// Service worker: permite instalar el tablero y la app del inspector, y abrirlos aunque la señal sea mala.
// Estrategia: red primero y, si no hay conexión, la última copia guardada. Supabase nunca se cachea.
const CACHE = 'gdo-v4';
const BASE = ['./', 'index.html', 'inspector.html', 'css/estilos.css', 'css/inspector.css',
  'js/app.js', 'js/inspector.js', 'js/config.js', 'js/tema.js', 'js/notificaciones.js', 'js/foto-sello.js',
  'manifest.json', 'manifest-tablero.json', 'img/icono.svg', 'img/icono-192.png', 'img/hydrogis.png', 'img/hydrogis-oscuro.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('supabase.co') || u.hostname.includes('tile.openstreetmap') || u.hostname.includes('arcgisonline')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (u.origin === location.origin || /jsdelivr|unpkg|fonts\.(googleapis|gstatic)/.test(u.hostname))) {
      const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia));
    }
    return r;
  }).catch(() => caches.match(e.request)));
});
