#!/usr/bin/env node
/*
  build-exotic-per-country.mjs , Statut exotique par pays depuis eBird API.

  eBird API v2 renvoie un champ exoticCategory sur chaque observation :
    N = Naturalized (population etablie durable)
    P = Provisional (obs regulieres mais pop non confirmee)
    X = Escapee (individu(s) echappe(s))
    C = obsolete alias, garde au cas ou

  Strategie 2 endpoints combines pour maximiser la couverture :
    1. /data/obs/{cc}/recent?back=30 : obs des 30 derniers jours (une par espece).
    2. /data/obs/{cc}/historic/YYYY/MM/DD : obs d'un jour precis. On sample le 15
       de chaque mois de l'annee passee pour rattraper les exotiques rares
       (Ibis sacre en hiver, Ouette d'Egypte en migration, etc.).

  Total : 1 + 12 = 13 calls par pays, ~1 min pour 6 pays.

  Priorite de merge : si une espece est vue avec N ET X sur differentes obs, on
  garde la categorie la plus etablie (N > P > X).

  SORTIE : tools/exotic-per-country.generated.js
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'exotic-per-country.generated.js');
const KEY = 'dbflh4atmsom';
const COUNTRIES = ['FR', 'ME', 'ES', 'IT', 'GB', 'PT'];

// Fenetre d'echantillonnage historique : 12 dates (une par mois de l'annee ecoulee)
// Date "de reference" = aujourd'hui. On recule mois par mois.
function samplesLast12Months(){
  const dates = [];
  const now = new Date();
  const y0 = now.getFullYear(), m0 = now.getMonth();   // m0 : 0..11
  for(let i = 0; i < 12; i++){
    let y = y0, m = m0 - i;
    while(m < 0){ y--; m += 12; }
    dates.push({ y, m: m + 1, d: 15 });   // 15 du mois
  }
  return dates;
}

const REAL_RARITY_PATH = join(__dir, 'real-rarity.generated.js');
const rarSrc = readFileSync(REAL_RARITY_PATH, 'utf8');
const rarMatch = rarSrc.match(/REAL_RARITY\s*=\s*(\{[\s\S]*?\})\s*;/);
const REAL_RARITY_FR = rarMatch ? JSON.parse(rarMatch[1]) : {};
console.log(`Charge ${Object.keys(REAL_RARITY_FR).length} entrees REAL_RARITY_FR pour filtre X sur sauvages.`);

async function fetchJSON(url){
  const r = await fetch(url, { headers: { 'X-eBirdApiToken': KEY } });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Priorite N > P > X. On garde la plus etablie si obs multiples pour la meme espece.
function mergeCat(existing, incoming){
  const rank = { N: 3, P: 2, X: 1, C: 1 };
  if(!existing) return incoming;
  return (rank[incoming] || 0) > (rank[existing] || 0) ? incoming : existing;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const result = {};
for(const cc of COUNTRIES){
  console.log(`\n=== ${cc} ===`);
  const exotics = {};
  const skippedX = new Set();

  // Etape 1 : 30 derniers jours (une entree par espece)
  process.stdout.write(`  [30j] `);
  try{
    const obs = await fetchJSON(`https://api.ebird.org/v2/data/obs/${cc}/recent?back=30&includeProvisional=true`);
    let newCount = 0;
    for(const o of obs){
      if(!o.exoticCategory || !o.sciName) continue;
      const k = o.sciName.toLowerCase();
      if(k.includes(' x ')) continue;
      if(cc === 'FR' && o.exoticCategory === 'X' && REAL_RARITY_FR[k]){ skippedX.add(k); continue; }
      if(k === 'columba livia'){ skippedX.add(k); continue; }
      const prev = exotics[k];
      exotics[k] = mergeCat(prev, o.exoticCategory);
      if(!prev) newCount++;
    }
    console.log(`${obs.length} obs, ${newCount} exotiques uniques`);
  }catch(e){ console.log('ERR:', e.message); }
  await sleep(300);

  // Etape 2 : 12 dates historiques (15 de chaque mois sur l'annee ecoulee)
  const dates = samplesLast12Months();
  for(const {y, m, d} of dates){
    process.stdout.write(`  [${y}-${String(m).padStart(2,'0')}-${d}] `);
    try{
      const obs = await fetchJSON(
        `https://api.ebird.org/v2/data/obs/${cc}/historic/${y}/${m}/${d}?includeProvisional=true&maxResults=1000`
      );
      let newCount = 0, added = 0;
      for(const o of obs){
        if(!o.exoticCategory || !o.sciName) continue;
        const k = o.sciName.toLowerCase();
        if(k.includes(' x ')) continue;
        if(cc === 'FR' && o.exoticCategory === 'X' && REAL_RARITY_FR[k]){ skippedX.add(k); continue; }
        if(k === 'columba livia'){ skippedX.add(k); continue; }
        const prev = exotics[k];
        const merged = mergeCat(prev, o.exoticCategory);
        exotics[k] = merged;
        if(!prev) added++;
      }
      console.log(`${obs.length} obs, +${added} nouveau${added>1?'x':''}`);
    }catch(e){ console.log('ERR:', e.message); }
    await sleep(300);
  }

  console.log(`  TOTAL ${cc} : ${Object.keys(exotics).length} especes exotiques (skip ${skippedX.size} X sur sauvages)`);
  result[cc] = exotics;
}

writeFileSync(OUT,
  `// Genere par tools/build-exotic-per-country.mjs depuis eBird API v2.\n` +
  `// Ne pas editer a la main. Regenerable : node tools/build-exotic-per-country.mjs\n` +
  `//\n` +
  `// Format : { regionCode: { sciName: category } }\n` +
  `// Categorie eBird : N (Naturalized) | P (Provisional) | X (Escapee) | C (obsolete)\n` +
  `//\n` +
  `// Source : combinaison de 2 endpoints eBird pour maximiser la couverture :\n` +
  `//   - /v2/data/obs/{cc}/recent?back=30 (30 jours glissants)\n` +
  `//   - /v2/data/obs/{cc}/historic/YYYY/MM/15 (15 de chaque mois sur l'annee ecoulee)\n` +
  `// Priorite categorie : N > P > X si une espece est vue avec plusieurs statuts.\n` +
  `//\n` +
  `// index.html merge ce dict avec la liste EXOTIC curatorial en fallback pour les\n` +
  `// exotiques historiquement connus non observes sur les 12 derniers mois.\n` +
  `export const EXOTIC_BY_COUNTRY = ${JSON.stringify(result)};\n`
);
console.log(`\n✓ Ecrit ${OUT}`);
console.log('\nRecap categories :');
for(const cc of COUNTRIES){
  const cats = {};
  for(const v of Object.values(result[cc])) cats[v] = (cats[v]||0) + 1;
  console.log(`  ${cc} :`, Object.keys(result[cc]).length, 'total,', cats);
}
