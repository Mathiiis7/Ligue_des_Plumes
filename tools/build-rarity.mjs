#!/usr/bin/env node
/*
  build-rarity.mjs — Génère le barème de "rareté réelle" de la Ligue Merlin Bird.

  PRINCIPE
  --------
  Pour chaque espèce connue de l'app (dictionnaire FR_NAMES de index.html), on
  demande à GBIF (base publique d'occurrences) le nombre d'observations en FRANCE,
  toutes sources confondues (eBird, iNaturalist, muséums, atlas...). Moins une
  espèce est observée en France, plus son poids (1 à 9) est élevé.

  SOURCE
  ------
  1) https://api.gbif.org/v1/species/match?name=<nom scientifique>   -> usageKey
  2) https://api.gbif.org/v1/occurrence/search?country=FR&taxonKey=<usageKey>&limit=0 -> count

  BARÈME (seuils fixes, en nombre d'observations FR) — SOURCE DE VÉRITÉ DU POIDS
  ----------------------------------------------------------------------------
     n >= 500000 -> 1  Très commun
     n >= 150000 -> 2  Commun
     n >=  50000 -> 3  Assez commun
     n >=  15000 -> 4  Peu commun
     n >=   5000 -> 5  Localisé
     n >=   1500 -> 6  Assez rare
     n >=    500 -> 7  Rare
     n >=    100 -> 8  Très rare
     n <     100 -> 9  Exceptionnel

  Remarque : les espèces exotiques/échappées (liste EXOTIC dans index.html) sont
  forcées à 1 au moment de l'affichage (fonction rarityReal), quel que soit le
  poids calculé ici — inutile de les traiter à part.

  SORTIES
  -------
  - tools/rarity-cache.json      : cache {sci: {key, matchType, count}} (reprise)
  - tools/rarity-data.json       : audit complet {sci, name, key, matchType, count, weight}
  - tools/real-rarity.generated.js : littéral `const REAL_RARITY = {...}` (poids >= 2)

  USAGE : node tools/build-rarity.mjs
  (relançable : le cache évite de re-télécharger ce qui a déjà été récupéré)
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// --- Seuils : count FR -> poids (source de vérité) ---
const THRESHOLDS = [
  [500000, 1], [150000, 2], [50000, 3], [15000, 4],
  [5000, 5], [1500, 6], [500, 7], [100, 8],
];
function weightFor(count) {
  for (const [min, w] of THRESHOLDS) if (count >= min) return w;
  return 9; // < 100
}

// Alias : certaines espèces (taxonomie eBird récente) ne sont pas dans le backbone
// GBIF sous leur nom actuel -> GBIF retombe sur un taxon SUPÉRIEUR (genre, voire racine)
// et renvoie un comptage aberrant. On requête alors sous l'ancien nom reconnu par GBIF,
// où les occurrences françaises sont réellement classées.
const GBIF_ALIAS = {
  'astur gentilis':      'accipiter gentilis',   // Autour des palombes
  'botaurus minutus':    'ixobrychus minutus',   // Blongios nain
  'botaurus sturmii':    'ixobrychus sturmii',   // Blongios de Sturm
  'anarhynchus mongolus':'charadrius mongolus',  // Pluvier de Mongolie
  'anarhynchus atrifrons':'charadrius atrifrons', // Pluvier du Tibet
  'anarhynchus pecuarius':'charadrius pecuarius', // Pluvier pâtre
  'anthus japonicus':    'anthus rubescens',     // Pipit de Sibérie (proxy : complexe rubescens)
  'cecropis rufula':     'cecropis daurica',     // Hirondelle rousseline
};

// --- Récupère le dictionnaire FR_NAMES depuis index.html ---
function loadSpecies() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const FR_NAMES = (\{.*?\});/s);
  if (!m) throw new Error('FR_NAMES introuvable dans index.html');
  const FR = JSON.parse(m[1]);
  return FR; // { "sci lowercase": "Nom français", ... }
}

const CACHE_PATH = join(__dir, 'rarity-cache.json');
let cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
function saveCache() { writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0)); }

async function fetchJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'ligue-merlin-bird/1.0 (rarity build)' } });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function gbifCount(sci) {
  if (cache[sci] && cache[sci].reliable) return cache[sci]; // réutilise seulement les matchs fiables
  const queryName = GBIF_ALIAS[sci] || sci;
  // class=Aves + kingdom=Animalia : évite les collisions de noms de genre avec des plantes
  // (ex. "Chloris chloris" l'oiseau vs "Chloris" la graminée)
  const match = await fetchJSON('https://api.gbif.org/v1/species/match?class=Aves&kingdom=Animalia&name=' + encodeURIComponent(queryName));
  const rank = match.rank || '';
  // fiable = match exact/fuzzy AU NIVEAU ESPÈCE (sinon GBIF a retombé sur un taxon supérieur)
  const reliable = (match.matchType === 'EXACT' || match.matchType === 'FUZZY') && (rank === 'SPECIES' || rank === 'SUBSPECIES');
  const key = reliable ? (match.usageKey || match.acceptedUsageKey || null) : null;
  let count = 0;
  if (key) {
    const occ = await fetchJSON('https://api.gbif.org/v1/occurrence/search?country=FR&limit=0&taxonKey=' + key);
    count = occ.count || 0;
  }
  const rec = { key, matchType: match.matchType || 'NONE', rank, reliable, alias: GBIF_ALIAS[sci] || null, count };
  cache[sci] = rec;
  return rec;
}

// Pool de concurrence
async function mapPool(items, size, fn, onTick) {
  const out = new Array(items.length);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { error: String(e) }; }
      done++;
      if (onTick && done % 20 === 0) onTick(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

(async () => {
  const FR = loadSpecies();
  const names = Object.keys(FR);
  console.log('Espèces à traiter :', names.length);

  let sinceSave = 0;
  let recs = await mapPool(names, 6, async (sci) => {
    try {
      const r = await gbifCount(sci);
      if (++sinceSave >= 25) { saveCache(); sinceSave = 0; }
      const reliable = r.reliable !== undefined ? r.reliable : !!r.key;
      const weight = reliable ? weightFor(r.count) : 9; // match non fiable -> traité comme Exceptionnel
      return { sci, name: FR[sci], key: r.key, matchType: r.matchType, alias: r.alias || null, count: r.count, weight };
    } catch (e) {
      return { sci, name: FR[sci], key: null, matchType: 'ERROR', count: 0, weight: null, error: String(e) };
    }
  }, (d, t) => { saveCache(); console.log(`  ${d}/${t}`); });
  saveCache();

  const errors = recs.filter(r => !r || r.weight === null);
  recs = recs.filter(r => r && r.weight !== null);
  if (errors.length) console.log('\n⚠️  Échecs (à relancer) :', errors.length, errors.map(e => e.sci).join(', '));

  // Audit complet
  recs.sort((a, b) => a.sci.localeCompare(b.sci));
  writeFileSync(join(__dir, 'rarity-data.json'), JSON.stringify(recs, null, 2));

  // Littéral REAL_RARITY (poids >= 2 seulement ; les poids 1 = défaut à l'exécution)
  const obj = {};
  for (const r of recs) if (r.weight >= 2) obj[r.sci] = r.weight;
  const literal = 'const REAL_RARITY = ' + JSON.stringify(obj) + ';\n';
  writeFileSync(join(__dir, 'real-rarity.generated.js'), literal);

  // Récap
  const dist = {}; for (let w = 1; w <= 9; w++) dist[w] = 0;
  for (const r of recs) dist[r.weight]++;
  const nomatch = recs.filter(r => r.matchType === 'NONE').map(r => r.sci);
  console.log('\nRépartition par poids :', JSON.stringify(dist));
  console.log('Espèces poids >= 2 (dans REAL_RARITY) :', Object.keys(obj).length);
  console.log('Non matchées par GBIF :', nomatch.length, nomatch.slice(0, 20).join(', '));
  console.log('\nÉcrit : tools/rarity-data.json, tools/real-rarity.generated.js');
})();
