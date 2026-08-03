// Service worker : cache stale-while-revalidate pour accelerer les rechargements.
// - index.html + statiques memes-origine : sert la version en cache instantanement,
//   puis rafraichit en background. Prochain reload = nouvelle version.
// - Requetes cross-origin (Firestore, iNaturalist, xeno-canto, Wikipedia, etc.) : reseau seul.
// - Bump CACHE_VERSION quand on veut invalider volontairement.
const CACHE_VERSION = 'v3-2026-08-03';
const CACHE_NAME = 'lmb-' + CACHE_VERSION;

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge les vieux caches (autres versions).
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Uniquement les statiques memes-origine (pas Firestore, pas les APIs externes).
  if (url.origin !== self.location.origin) return;
  // On ignore les requetes navigation avec des query strings importantes (?league=..., ?...).
  // On sert quand meme la meme index en cache : les params sont lus cote client au boot.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    // Fetch en arriere-plan pour rafraichir le cache.
    const fetchAndCache = fetch(req).then(res => {
      // Ne cache que les reponses OK, opaques exclues.
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);
    // Renvoie immediatement le cache s'il existe (rapidite), sinon attend le reseau.
    return cached || fetchAndCache || new Response('', { status: 504 });
  })());
});
