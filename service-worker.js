// Service worker : cache stale-while-revalidate pour accelerer les rechargements.
// - index.html + statiques memes-origine : sert la version en cache instantanement,
//   puis rafraichit en background. Prochain reload = nouvelle version.
// - Requetes cross-origin (Firestore, iNaturalist, xeno-canto, Wikipedia, etc.) : reseau seul.
// - Bump CACHE_VERSION quand on veut invalider volontairement.
const CACHE_VERSION = 'v552-2026-09-26-danemark-et-suisse-reparee';
const CACHE_NAME = 'lmb-' + CACHE_VERSION;

// Cache des fichiers de donnees, volontairement SANS CACHE_VERSION dans son nom.
//
// Avant, tout vivait dans 'lmb-' + CACHE_VERSION et l'activate supprimait tout cache portant
// un autre nom : chaque deploiement, meme une retouche de CSS, jetait des megaoctets de
// donnees qui n'avaient pas bouge - freq_by_region.json fait 2,55 Mo pour la France et
// 2,06 Mo pour les Etats-Unis. Le 26/09/2026, 25 deploiements ont ainsi fait retelecharger
// ces fichiers 25 fois.
//
// Ces donnees ont deja leur propre versionnement : chaque URL porte un ?v=AAAAMMJJ ecrit en
// dur dans app.js, qu'on bumpe quand on regenere le fichier (freq_48.json?v=20260923,
// freq_by_region.json?v=20260830...). Ce parametre suffit a les invalider, a condition de
// comparer les URL completes - cf. le match exact plus bas.
const DATA_CACHE = 'lmb-data';

// Donnees gardees d'un deploiement a l'autre. Exclut data/range-weekly/ : 304 especes pour
// 143 Mo, consultees au coup par coup. Les garder indefiniment ferait gonfler le stockage
// du navigateur sans vrai benefice, elles restent donc dans le cache versionne.
function estDonneesPersistantes(pathname){
  if (!pathname.includes('/data/')) return false;
  if (pathname.includes('/data/range-weekly/')) return false;
  return true;
}

// En developpement local, le SW ne sert jamais depuis le cache : on regenere un JSON, on
// recharge, on le voit. Sans ca il faudrait vider le cache a la main a chaque build.
function estDevLocal(){
  const h = self.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

// Supprime les entrees du meme fichier restees sous un ancien ?v=. Sans ca, bumper le
// parametre laisserait l'ancienne copie dans un cache qu'on ne purge plus jamais.
async function purgerAnciennesVersions(cache, url){
  try {
    const clefs = await cache.keys();
    for (const c of clefs) {
      const u = new URL(c.url);
      if (u.pathname === url.pathname && u.search !== url.search) await cache.delete(c);
    }
  } catch (_) {}
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge les vieux caches (autres versions), mais garde celui des donnees.
    const garder = [CACHE_NAME, DATA_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !garder.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (estDevLocal()) return;
  const url = new URL(req.url);
  // Uniquement les statiques memes-origine (pas Firestore, pas les APIs externes).
  if (url.origin !== self.location.origin) return;
  // IMPORTANT : jamais cacher le SW lui-meme, sinon impossible de le mettre a jour
  // (browser fetch service-worker.js -> SW intercepte -> renvoie l'ancien -> pas d'update).
  if (url.pathname.endsWith('/service-worker.js') || url.pathname.endsWith('/sw.js')) return;
  // Ni app.js ni index.html : servis fresh a chaque fois. Sans ca, une nouvelle version
  // du code deploye met plusieurs reloads a etre servie (stale-while-revalidate a un
  // reload de retard). Cout minimal grace au HTTP cache navigateur.
  if (url.pathname.endsWith('/app.js') || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/styles.css') || url.pathname === '/Ligue_des_Plumes/') return;
  // Ni le manifest range (evolue frequemment avec nouvelles especes generees).
  if (url.pathname.endsWith('/data/range-index.json')) return;
  // data/generated/ retire du repo (2026-09-02) : etaient des build artifacts
  // jamais fetches par le site (data inline dans app.js). Cette regle bypass devient
  // inutile mais laissee pour retrocompat au cas ou.
  if (url.pathname.includes('/data/generated/')) return;
  const donnees = estDonneesPersistantes(url.pathname);
  // On ignore les requetes navigation avec des query strings importantes (?league=..., ?...).
  // On sert quand meme la meme index en cache : les params sont lus cote client au boot.
  event.respondWith((async () => {
    const cache = await caches.open(donnees ? DATA_CACHE : CACHE_NAME);
    // Match EXACT pour les donnees : leur ?v=AAAAMMJJ est justement ce qui les invalide,
    // ignoreSearch renverrait l'ancienne version et le bump ne servirait a rien. Les autres
    // statiques gardent ignoreSearch, pour les navigations a parametres.
    const cached = await cache.match(req, { ignoreSearch: !donnees });
    // Fetch en arriere-plan pour rafraichir le cache.
    const fetchAndCache = fetch(req).then(res => {
      // Ne cache que les reponses OK, opaques exclues.
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
        if (donnees) purgerAnciennesVersions(cache, url);
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
