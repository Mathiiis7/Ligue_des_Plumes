#!/usr/bin/env node
/*
  build-habitats-iucn.mjs — Habitats par espèce depuis IUCN Red List API v3.

  Remplace le mapping famille eBird de build-habitats.mjs par une source
  espèce-par-espèce beaucoup plus fine (l'aigle royal est classé "rocher/
  montagne" au lieu de "forestier/bocage/montagne" comme sa famille).

  UTILISATION
  -----------
    1. Récupère ta clé sur https://apiv3.iucnredlist.org/api/v3/token
    2. Colle-la dans tools/.iucn-key (une ligne, gitignorée)
    3. node tools/build-habitats-iucn.mjs
    4. Le script régénère tools/habitats.generated.js + audit

  RATE LIMIT
  ----------
    IUCN autorise ~2 req/s (docs mentionnent "generous but avoid abuse").
    Ce script fait 1 req/700ms séquentiellement = ~8 min pour 720 espèces.
    Cache local dans tools/iucn-habitats-cache.json (gitignoré) pour ne
    pas re-fetcher les espèces déjà vues d'un run à l'autre.

  MAPPING
  -------
    Codes IUCN Habitats Classification Scheme v3.1 → 10 catégories app.
    Voir IUCN_TO_CATS ci-dessous. On garde uniquement les habitats marqués
    "Suitable" ou "Marginal" (on ignore "Unknown").
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

// --- Clé API ---
const KEY_FILE = join(__dir, '.iucn-key');
if (!existsSync(KEY_FILE)) {
  console.error('❌ Clé IUCN introuvable. Crée le fichier tools/.iucn-key avec ta clé (une ligne).');
  console.error('   Demande la clé sur https://apiv3.iucnredlist.org/api/v3/token');
  process.exit(1);
}
const TOKEN = readFileSync(KEY_FILE, 'utf8').trim();
if (!TOKEN) { console.error('❌ tools/.iucn-key est vide.'); process.exit(1); }

// --- Cache local (persistant entre runs) ---
const CACHE_FILE = join(__dir, 'iucn-habitats-cache.json');
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
const save = () => writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));

// --- Mapping codes IUCN → catégories app ---
// On garde LES 14 CATÉGORIES TOP-LEVEL de IUCN telles quelles (pas de collapse
// arbitraire). Chaque sous-code x.y mappe vers sa top-level x.
// https://www.iucnredlist.org/resources/habitat-classification-scheme
const IUCN_TO_CATS = {
  // Chaque top-level : identifiant court app + Français lisible dans HABITAT_LABELS.
  '1':   ['forest'],       // Forest
  '2':   ['savanna'],      // Savanna
  '3':   ['shrubland'],    // Shrubland
  '4':   ['grassland'],    // Grassland
  '5':   ['wetlands'],     // Wetlands (inland)
  '6':   ['rocky'],        // Rocky areas
  '7':   ['caves'],        // Caves & Subterranean
  '8':   ['desert'],       // Desert
  '9':   ['neritic'],      // Marine Neritic
  '10':  ['oceanic'],      // Marine Oceanic
  '11':  ['deepocean'],    // Marine Deep Ocean Floor
  '12':  ['intertidal'],   // Marine Intertidal
  '13':  ['coast'],        // Marine Coastal / Supratidal
  '14':  ['artificial'],   // Artificial - Terrestrial
};
// Sous-codes : "x.y" → parent "x". Généré automatiquement à partir de la table
// top-level pour couvrir tous les niveaux fins que l'API renvoie.
function parentOf(code) {
  const dot = String(code).indexOf('.');
  return dot < 0 ? String(code) : String(code).slice(0, dot);
}
function mapCode(code) {
  return IUCN_TO_CATS[String(code)] || IUCN_TO_CATS[parentOf(code)] || null;
}

// --- Charge la liste ---
const eb = JSON.parse(readFileSync(join(__dir, 'rarity-data-ebird.json'), 'utf8'));
const sciNames = eb.map(r => r.sci).filter(Boolean);
console.log(`→ ${sciNames.length} espèces à interroger sur IUCN.`);

// --- Utility : fetch avec retry sur 429/5xx ---
async function fetchIUCN(sci) {
  const url = `https://apiv3.iucnredlist.org/api/v3/habitats/species/name/${encodeURIComponent(sci)}?token=${TOKEN}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'ligue-plumes/1.0' } });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 2000 * (attempt+1))); continue; }
    if (r.status >= 500) { await new Promise(res => setTimeout(res, 1000 * (attempt+1))); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  throw new Error('trop de retries');
}

// --- Fetch séquentiel avec rate-limit ---
const raw = {};       // sci → [{code, suitability, ...}, ...]
let done = 0, hitCache = 0, hitApi = 0, notFound = 0, failed = 0;

for (const sci of sciNames) {
  const sciCap = sci.replace(/^(.)/, c => c.toUpperCase());
  done++;
  if (cache[sci] !== undefined) {
    raw[sci] = cache[sci];
    hitCache++;
  } else {
    try {
      const j = await fetchIUCN(sciCap);
      const habs = Array.isArray(j.result) ? j.result.filter(h => /Suitable|Marginal/i.test(h.suitability||'Suitable')) : [];
      raw[sci] = habs;
      cache[sci] = habs;
      hitApi++;
      if (!habs.length) notFound++;
      // rate-limit : 700ms entre appels réels
      await new Promise(res => setTimeout(res, 700));
      // sauvegarde cache régulièrement
      if (hitApi % 25 === 0) save();
    } catch (e) {
      failed++;
      cache[sci] = null;
      raw[sci] = null;
      console.log(`  ${sci} ✗ ${e.message}`);
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  if (done % 50 === 0) {
    process.stdout.write(`  ${done}/${sciNames.length} (cache:${hitCache} api:${hitApi} vide:${notFound} fail:${failed})\n`);
  }
}
save();
console.log(`\n→ Terminé : cache=${hitCache}, api=${hitApi}, sans habitat IUCN=${notFound}, échec=${failed}`);

// --- Applique le mapping ---
const HABITATS = {};
const unmapped = {};  // codes IUCN non mappés → count
let mappedCount = 0, noneCount = 0;
for (const sci of sciNames) {
  const habs = raw[sci];
  if (!habs || !habs.length) { noneCount++; continue; }
  const cats = new Set();
  for (const h of habs) {
    const code = String(h.code || '').trim();
    const m = mapCode(code);
    if (m) m.forEach(c => cats.add(c));
    else if (code) unmapped[code] = (unmapped[code] || 0) + 1;
  }
  if (cats.size) {
    HABITATS[sci] = [...cats].sort();
    mappedCount++;
  } else noneCount++;
}

console.log(`\n→ ${mappedCount}/${sciNames.length} espèces mappées (${Math.round(100*mappedCount/sciNames.length)}%).`);
console.log(`  ${noneCount} sans habitat exploitable.`);

const topUnmapped = Object.entries(unmapped).sort((a,b)=>b[1]-a[1]).slice(0, 30);
if (topUnmapped.length) {
  console.log(`\nCodes IUCN NON mappés (à ajouter à IUCN_TO_CATS si pertinent) :`);
  for (const [c, n] of topUnmapped) console.log(`  ${c}  (${n} occurrences)`);
}

// 14 catégories IUCN top-level (mêmes clés que HABITAT_LABELS dans index.html à mettre à jour).
const CATS = ['forest','savanna','shrubland','grassland','wetlands','rocky','caves','desert','neritic','oceanic','deepocean','intertidal','coast','artificial'];
const catCounts = Object.fromEntries(CATS.map(c=>[c,0]));
for (const cats of Object.values(HABITATS)) for (const c of cats) if (catCounts[c] !== undefined) catCounts[c]++;
console.log(`\nDistribution :`);
for (const c of CATS) console.log(`  ${c.padEnd(10)} : ${catCounts[c]} espèces`);

// --- Écriture ---
const out = `// Généré par tools/build-habitats-iucn.mjs — Habitats depuis IUCN Red List (10 catégories).\n` +
            `// Ne pas éditer à la main. Regénérable : node tools/build-habitats-iucn.mjs\n` +
            `export const HABITATS = ${JSON.stringify(HABITATS, null, 0)};\n` +
            `export const HABITAT_CATS = ${JSON.stringify(CATS)};\n`;
writeFileSync(join(__dir, 'habitats.generated.js'), out);
writeFileSync(join(__dir, 'habitats-audit.json'), JSON.stringify({
  source: 'IUCN Red List v3',
  mappedCount, noneCount, catCounts,
  topUnmapped,
  sample: Object.entries(HABITATS).slice(0, 30).map(([k,v]) => `${k}: ${v.join(', ')}`)
}, null, 2));
console.log(`\n✓ Écrit tools/habitats.generated.js et tools/habitats-audit.json`);
console.log(`  Pour injecter dans index.html : voir le pattern dans build-habitats.mjs (edit manuel des 2 lignes).`);
