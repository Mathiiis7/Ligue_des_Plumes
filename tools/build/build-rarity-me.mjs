#!/usr/bin/env node
/*
  build-rarity-me.mjs — Rareté GBIF spécifique au Monténégro.

  PRINCIPE
  --------
  Sur le même principe que la rareté FR (build-rarity-ebird.mjs), on calcule
  une échelle 1-9 à partir de la fréquence d'observation. Différences :
  - Source : GBIF (facet=speciesKey sur country=ME, birds only), pas eBird bar chart
    (endpoint eBird barchart réservé aux utilisateurs authentifiés, pas d'API v2 publique).
  - Métrique : share = obs de l'espèce / total obs oiseaux ME. Moins précis qu'eBird
    (pas normalisé par effort), mais rangs quasi identiques pour un pays donné.
  - Seuils recalibrés : la distribution GBIF est plus tassée que celle eBird.

  BARÈME (share en % du total obs oiseaux ME)
     >= 2.0  -> 1  Très commun
     >= 1.0  -> 2  Commun
     >= 0.5  -> 3  Assez commun
     >= 0.2  -> 4  Peu commun
     >= 0.1  -> 5  Localisé
     >= 0.05 -> 6  Assez rare
     >= 0.02 -> 7  Rare
     >= 0.005-> 8  Très rare
     <  0.005-> 9  Exceptionnel

  SORTIE
  ------
  - tools/real-rarity-me.generated.js : littéral `const REAL_RARITY_ME = {...}`
    à inclure dans index.html (à la place ou en plus de REAL_RARITY selon le pays).

  USAGE : node tools/build-rarity-me.mjs
*/
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const COUNTRY = 'ME';
const OUT = join(__dir, 'real-rarity-me.generated.js');

const THRESHOLDS = [
  [2.0, 1], [1.0, 2], [0.5, 3], [0.2, 4],
  [0.1, 5], [0.05, 6], [0.02, 7], [0.005, 8],
];
function weightFor(share){ for(const [min, w] of THRESHOLDS) if(share >= min) return w; return 9; }

async function main(){
  console.log(`Fetching GBIF facet=speciesKey pour ${COUNTRY}...`);
  const facetUrl = `https://api.gbif.org/v1/occurrence/search?country=${COUNTRY}&classKey=212&hasCoordinate=true&limit=0&facet=speciesKey&facetLimit=1000`;
  const jFacet = await (await fetch(facetUrl)).json();
  const totalObs = jFacet.count;
  const facets = jFacet.facets[0].counts;
  console.log(`Total obs oiseaux ${COUNTRY} : ${totalObs}, ${facets.length} especes distinctes`);

  // Pour chaque speciesKey, fetch le sciName via /species/{key}
  console.log('Fetching sciName pour chaque speciesKey (pool 10)...');
  const map = {};   // sciName lowercase -> weight
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
          if(sci){
            const share = count / totalObs * 100;
            map[sci] = weightFor(share);
          }
        }
      }catch(_){}
      done++;
      if(done % 50 === 0) process.stdout.write(`  ${done}/${facets.length}\n`);
    }
  }
  await Promise.all(Array.from({length: POOL}, worker));

  // Distribution
  const bins = {1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0};
  for(const w of Object.values(map)) bins[w]++;
  console.log('\nDistribution par tier :');
  for(const [k,v] of Object.entries(bins)) console.log(`  tier ${k} : ${v} especes`);

  const body = `// Genere par tools/build-rarity-me.mjs a partir de GBIF (facet speciesKey ${COUNTRY}).\n` +
               `// Ne pas editer a la main. Regenerable : node tools/build-rarity-me.mjs\n` +
               `export const REAL_RARITY_ME = ${JSON.stringify(map)};\n`;
  writeFileSync(OUT, body);
  console.log(`\n✓ Ecrit ${OUT} (${Object.keys(map).length} especes).`);
}

main().catch(err => { console.error(err); process.exit(1); });
