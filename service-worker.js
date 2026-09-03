// Service worker : cache stale-while-revalidate pour accelerer les rechargements.
// - index.html + statiques memes-origine : sert la version en cache instantanement,
//   puis rafraichit en background. Prochain reload = nouvelle version.
// - Requetes cross-origin (Firestore, iNaturalist, xeno-canto, Wikipedia, etc.) : reseau seul.
// - Bump CACHE_VERSION quand on veut invalider volontairement.
const CACHE_VERSION = 'v20-2026-09-03-families-sort-all';
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
  // IMPORTANT : jamais cacher le SW lui-meme, sinon impossible de le mettre a jour
  // (browser fetch service-worker.js -> SW intercepte -> renvoie l'ancien -> pas d'update).
  if (url.pathname.endsWith('/service-worker.js') || url.pathname.endsWith('/sw.js')) return;
  // Ni app.js ni index.html : servis fresh a chaque fois. Sans ca, une nouvelle version
  // du code deploye met plusieurs reloads a etre servie (stale-while-revalidate a un
  // reload de retard). Cout minimal grace au HTTP cache navigateur.
  if (url.pathname.endsWith('/app.js') || url.pathname.endsWith('/index.html') || url.pathname === '/Ligue_des_Plumes/') return;
  // Ni le manifest range (evolue frequemment avec nouvelles especes generees).
  if (url.pathname.endsWith('/data/range-index.json')) return;
  // data/generated/ retire du repo (2026-09-02) : etaient des build artifacts
  // jamais fetches par le site (data inline dans app.js). Cette regle bypass devient
  // inutile mais laissee pour retrocompat au cas ou.
  if (url.pathname.includes('/data/generated/')) return;
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
    // Await explicite pour eviter que fetchAndCache resolve a null cassant respondWith.
    if (cached) return cached;
    const netRes = await fetchAndCache;
    return netRes || new Response('', { status: 504, statusText: 'No cache and network failed' });
  })());
});
