#!/usr/bin/env node
/*
  build-rarity-exo-gbif.mjs — Rareté "observabilité réelle" des exotiques FR via GBIF.

  Pourquoi : eBird filtre les oiseaux marqués captifs, ce qui sous-classe les exotiques
  de parc (Oie à tête barrée, Cygne noir, Bernache nonnette...) qui sont totalement
  observables dans les parcs publics parisiens. GBIF via iNaturalist capture ces obs.

  Méthode :
    1) Fetch la facette speciesKey pour FR (une seule requête, donne les top ~500 taxons).
    2) Pour chaque taxonKey, résout sciName via /species/{key} et compare à la liste EXOTIC
       extraite d'index.html.
    3) Calcule share % = count / totalObs et applique un barème 1-9.

  Barème : les exotiques ne dépassent que rarement 0.5% du total, donc seuils décalés
  par rapport à build-rarity-me.mjs. Un exotique à 0.05% est déjà "commun à observer"
  dans son contexte (Perruche à collier ~0.05% en FR = tier 3-4).

  Sortie : tools/real-rarity-exo-gbif.generated.js
    export const REAL_RARITY_EXO_GBIF = { "anser indicus": 4, ... }

  Usage : node tools/build-rarity-exo-gbif.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const OUT = join(__dir, 'real-rarity-exo-gbif.generated.js');

// Barème pour exotiques FR : seuils plus bas (les intros ne franchissent presque jamais 1%).
// Calibré sur : Perruche à collier 0.05% -> 3, Bernache Canada 0.1% -> 3, Oie tête barrée
// 0.005% -> 5, Faisan 0.3% -> 2, Cygne noir 0.008% -> 5.
const THRESHOLDS = [
  [0.5, 1], [0.2, 2], [0.05, 3], [0.02, 4],
  [0.008, 5], [0.003, 6], [0.001, 7], [0.0003, 8],
];
function weightFor(share){ for(const [min, w] of THRESHOLDS) if(share >= min) return w; return 9; }

// Extrait la liste EXOTIC de index.html (JSON-like sur une ligne).
function extractExoticList(){
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const EXOTIC=(\{[^}]+\})/);
  if(!m) throw new Error('EXOTIC constant not found in index.html');
  const EXOTIC = eval('(' + m[1] + ')');
  return new Set(Object.keys(EXOTIC).map(s => s.toLowerCase().trim()));
}

async function main(){
  const exoticSet = extractExoticList();
  console.log(`Exotiques a calibrer : ${exoticSet.size}`);

  console.log('Fetching GBIF facet=speciesKey pour FR (top 1000 taxons)...');
  const facetUrl = `https://api.gbif.org/v1/occurrence/search?country=FR&classKey=212&hasCoordinate=true&limit=0&facet=speciesKey&facetLimit=1000`;
  const jFacet = await (await fetch(facetUrl)).json();
  const totalObs = jFacet.count;
  const facets = jFacet.facets[0].counts;
  console.log(`Total obs oiseaux FR : ${totalObs.toLocaleString()}, ${facets.length} especes distinctes dans le top 1000`);

  // Pour chaque taxonKey, resolve sciName + check si dans exoticSet.
  console.log('\nResolution sciName pour chaque speciesKey (pool 10)...');
  const map = {};   // sciName lowercase -> weight
  const found = [];
  let done = 0;
  const POOL = 10;
  let cursor = 0;
  async function worker(){
    while(cursor < facets.length){
      const i = cursor++;
      const key = parseInt(facets[i].name, 10);
      const count = facets[i].count;
      try{
        const r = await fetch(`https://api.gbif.org/v1/species/${key}`);
        if(r.ok){
          const j = await r.json();
          const sci = (j.canonicalName || '').toLowerCase().trim();
          if(sci && exoticSet.has(sci)){
            const share = count / totalObs * 100;
            const w = weightFor(share);
            map[sci] = w;
            found.push({ sci, share, w, count });
          }
        }
      }catch(_){}
      done++;
      if(done % 100 === 0) process.stdout.write(`  ${done}/${facets.length}\n`);
    }
  }
  await Promise.all(Array.from({length: POOL}, worker));

  console.log(`\n${found.length}/${exoticSet.size} exotiques trouvees dans le top 1000 GBIF FR.`);

  // Especes exotiques non trouvees dans le top -> tier 8-9 (rares meme sur GBIF).
  // On les ajoute a tier 8 par defaut : elles apparaitraient sinon en fallback tier 1
  // dans rarityForCountry qui est trompeur pour un exotique manifestement absent de GBIF.
  const missing = [...exoticSet].filter(s => !map[s]);
  for(const sci of missing) map[sci] = 8;
  console.log(`${missing.length} exotiques non trouvees dans le top 1000 -> tier 8 par defaut.`);

  // Distribution
  const bins = {1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0};
  for(const w of Object.values(map)) bins[w]++;
  console.log('\nDistribution par tier :');
  for(const [k,v] of Object.entries(bins)) console.log(`  tier ${k} : ${v} especes`);

  // Top 20 obs (les plus communs)
  console.log('\nTop 15 exotiques les plus vus :');
  found.sort((a,b) => b.count - a.count);
  for(const f of found.slice(0, 15)){
    console.log(`  ${f.sci.padEnd(30)} tier ${f.w}  share=${f.share.toFixed(4)}%  (${f.count} obs)`);
  }

  const body = `// Genere par tools/build-rarity-exo-gbif.mjs (GBIF facet speciesKey FR).\n` +
               `// Ne pas editer a la main. Regenerable : node tools/build-rarity-exo-gbif.mjs\n` +
               `const REAL_RARITY_EXO_GBIF = ${JSON.stringify(map)};\n`;
  writeFileSync(OUT, body);
  console.log(`\n✓ Ecrit ${OUT} (${Object.keys(map).length} exotiques).`);
}

main().catch(err => { console.error(err); process.exit(1); });
