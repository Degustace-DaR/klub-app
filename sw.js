// Minimální service worker jen kvůli instalovatelnosti appky na plochu (PWA).
// Úmyslně nic necachuje - appka pracuje s živými daty z Firestore a zastaralá
// cache by mohla ukázat neaktuální obsah. Requesty jen propouští dál na síť.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // no-op: necháváme prohlížeč obsloužit request normálně (žádná cache)
});
