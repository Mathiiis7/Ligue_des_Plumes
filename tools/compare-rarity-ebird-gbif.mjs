#!/usr/bin/env node
/*
  compare-rarity-ebird-gbif.mjs — Compare le tier eBird vs GBIF sur 50 especes temoins FR.

  Objectif : verifier si l'ecart est faible (~0-1 tier) ou systematique (2+ tiers dans un sens).
  Si faible -> GBIF peut remplacer eBird pour les wild birds. Si systematique -> on garde eBird.

  Methode :
    1) Fetch la facette speciesKey GBIF FR (58M obs, top 1000 taxons).
    2) Resout sciName pour chaque taxonKey (memes seuils que build-rarity-me.mjs).
    3) Compare avec REAL_RARITY (eBird) sur 50 especes temoins choisies pour couvrir tous
       les biais possibles : commun/rare, charismatique/cryptique, urbain/rural, jour/nuit.

  Usage : node tools/compare-rarity-ebird-gbif.mjs
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// Barème (memes seuils que build-rarity-me.mjs, calibre sur share % du total obs).
const THRESHOLDS = [
  [2.0, 1], [1.0, 2], [0.5, 3], [0.2, 4],
  [0.1, 5], [0.05, 6], [0.02, 7], [0.005, 8],
];
function weightFor(share){ for(const [min, w] of THRESHOLDS) if(share >= min) return w; return 9; }

// 50 especes temoins choisies pour couvrir les biais possibles.
const WITNESSES = [
  // --- Communs charismatiques (attendu: eBird 1-2, GBIF 1-2) ---
  { sci: 'turdus merula', nm: 'Merle noir', tag: 'charismatique commun' },
  { sci: 'erithacus rubecula', nm: 'Rougegorge familier', tag: 'charismatique commun' },
  { sci: 'parus major', nm: 'Mesange charbonniere', tag: 'charismatique commun' },
  { sci: 'cyanistes caeruleus', nm: 'Mesange bleue', tag: 'charismatique commun' },
  { sci: 'fringilla coelebs', nm: 'Pinson des arbres', tag: 'charismatique commun' },
  { sci: 'columba palumbus', nm: 'Pigeon ramier', tag: 'charismatique commun' },
  { sci: 'sturnus vulgaris', nm: 'Etourneau sansonnet', tag: 'charismatique commun' },
  { sci: 'passer domesticus', nm: 'Moineau domestique', tag: 'urbain commun' },
  { sci: 'pica pica', nm: 'Pie bavarde', tag: 'urbain commun' },

  // --- Communs cryptiques (attendu: eBird 2-3, GBIF plus rare?) ---
  { sci: 'phylloscopus collybita', nm: 'Pouillot veloce', tag: 'cryptique commun' },
  { sci: 'sylvia atricapilla', nm: 'Fauvette a tete noire', tag: 'cryptique commun' },
  { sci: 'cisticola juncidis', nm: 'Cisticole des joncs', tag: 'cryptique commun' },
  { sci: 'certhia brachydactyla', nm: 'Grimpereau des jardins', tag: 'cryptique commun' },
  { sci: 'saxicola rubicola', nm: 'Tarier patre', tag: 'cryptique commun' },
  { sci: 'acrocephalus scirpaceus', nm: 'Rousserolle effarvatte', tag: 'cryptique commun' },

  // --- Moyens (attendu: 3-4 partout) ---
  { sci: 'carduelis carduelis', nm: 'Chardonneret', tag: 'moyen' },
  { sci: 'motacilla alba', nm: 'Bergeronnette grise', tag: 'moyen' },
  { sci: 'sitta europaea', nm: 'Sittelle torchepot', tag: 'moyen' },
  { sci: 'apus apus', nm: 'Martinet noir', tag: 'moyen migrant' },
  { sci: 'hirundo rustica', nm: 'Hirondelle rustique', tag: 'moyen migrant' },
  { sci: 'cuculus canorus', nm: 'Coucou gris', tag: 'audible' },
  { sci: 'oriolus oriolus', nm: 'Loriot d\'Europe', tag: 'audible cryptique' },

  // --- Rares cryptiques (attendu: eBird 7-8, GBIF plus rare?) ---
  { sci: 'locustella luscinioides', nm: 'Locustelle luscinioide', tag: 'cryptique rare' },
  { sci: 'locustella naevia', nm: 'Locustelle tachetee', tag: 'cryptique rare' },
  { sci: 'acrocephalus paludicola', nm: 'Phragmite aquatique', tag: 'cryptique tres rare' },
  { sci: 'crex crex', nm: 'Rale des genets', tag: 'cryptique nocturne' },
  { sci: 'caprimulgus europaeus', nm: 'Engoulevent d\'Europe', tag: 'nocturne cryptique' },

  // --- Rares charismatiques (attendu: 6-8 partout, GBIF sur-represente?) ---
  { sci: 'aquila chrysaetos', nm: 'Aigle royal', tag: 'charismatique rare' },
  { sci: 'pandion haliaetus', nm: 'Balbuzard pecheur', tag: 'charismatique rare' },
  { sci: 'bubo bubo', nm: 'Grand-duc d\'Europe', tag: 'nocturne charismatique' },
  { sci: 'falco peregrinus', nm: 'Faucon pelerin', tag: 'charismatique moyen' },
  { sci: 'ciconia nigra', nm: 'Cigogne noire', tag: 'charismatique rare' },
  { sci: 'gypaetus barbatus', nm: 'Gypaete barbu', tag: 'charismatique tres rare' },

  // --- Aquatiques (attendu: photos frequentes -> GBIF sur-represente?) ---
  { sci: 'ardea alba', nm: 'Grande Aigrette', tag: 'aquatique charismatique' },
  { sci: 'ardea cinerea', nm: 'Heron cendre', tag: 'aquatique commun' },
  { sci: 'egretta garzetta', nm: 'Aigrette garzette', tag: 'aquatique moyen' },
  { sci: 'anas platyrhynchos', nm: 'Canard colvert', tag: 'aquatique commun urbain' },
  { sci: 'cygnus olor', nm: 'Cygne tubercule', tag: 'aquatique commun urbain' },

  // --- Rapaces jour (ID en vol -> GBIF sous-represente?) ---
  { sci: 'buteo buteo', nm: 'Buse variable', tag: 'rapace commun' },
  { sci: 'accipiter nisus', nm: 'Epervier d\'Europe', tag: 'rapace moyen' },
  { sci: 'milvus migrans', nm: 'Milan noir', tag: 'rapace commun' },
  { sci: 'falco tinnunculus', nm: 'Faucon crecerelle', tag: 'rapace commun urbain' },
  { sci: 'pernis apivorus', nm: 'Bondree apivore', tag: 'rapace rare' },

  // --- Nocturnes (GBIF sous-represente?) ---
  { sci: 'athene noctua', nm: 'Chouette cheveche', tag: 'nocturne moyen' },
  { sci: 'strix aluco', nm: 'Chouette hulotte', tag: 'nocturne commun' },
  { sci: 'tyto alba', nm: 'Effraie des clochers', tag: 'nocturne moyen' },

  // --- Divers ---
  { sci: 'picus viridis', nm: 'Pic vert', tag: 'audible cryptique' },
  { sci: 'dendrocopos major', nm: 'Pic epeiche', tag: 'audible moyen' },
  { sci: 'coccothraustes coccothraustes', nm: 'Grosbec casse-noyaux', tag: 'discret moyen' },
  { sci: 'vanellus vanellus', nm: 'Vanneau huppe', tag: 'aquatique charismatique' },
  { sci: 'gallinago gallinago', nm: 'Becassine des marais', tag: 'aquatique cryptique' },
];

async function main(){
  // Extrait REAL_RARITY eBird de index.html.
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const REAL_RARITY = JSON.parse(html.match(/const REAL_RARITY = (\{.*?\});/s)[1]);

  console.log(`Fetching GBIF facet=speciesKey pour FR (top 1000 taxons)...`);
  const facetUrl = `https://api.gbif.org/v1/occurrence/search?country=FR&classKey=212&hasCoordinate=true&limit=0&facet=speciesKey&facetLimit=1000`;
  const jFacet = await (await fetch(facetUrl)).json();
  const totalObs = jFacet.count;
  const facets = jFacet.facets[0].counts;
  console.log(`Total obs oiseaux FR : ${totalObs.toLocaleString()}, ${facets.length} especes distinctes.\n`);

  // Resout tous les taxonKeys en sciName (pool 10).
  console.log('Resolution sciName pour chaque taxonKey...');
  const gbifBySci = {};   // sci -> weight
  let done = 0, cursor = 0;
  const POOL = 10;
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
            gbifBySci[sci] = { w: weightFor(share), share, count };
          }
        }
      }catch(_){}
      done++;
      if(done % 200 === 0) process.stdout.write(`  ${done}/${facets.length}\n`);
    }
  }
  await Promise.all(Array.from({length: POOL}, worker));
  console.log(`✓ ${Object.keys(gbifBySci).length} taxons resolus.\n`);

  // Comparaison.
  console.log('='.repeat(120));
  console.log('Comparaison eBird vs GBIF sur 50 especes temoins FR');
  console.log('='.repeat(120));
  const header = 'Espece'.padEnd(28) + '| eBird  | GBIF  | Ecart | Tag';
  console.log(header);
  console.log('-'.repeat(header.length));
  const diffs = [];
  const rows = [];
  for(const w of WITNESSES){
    const eb = REAL_RARITY[w.sci];
    const gb = gbifBySci[w.sci];
    const ebTier = eb || 1;   // absent = tier 1 (convention app)
    const gbTier = gb ? gb.w : (gbifBySci[w.sci] ? gbifBySci[w.sci].w : 9);   // absent GBIF = 9 (hors top 1000)
    const diff = gbTier - ebTier;   // positif = GBIF plus rare
    diffs.push(diff);
    rows.push({ nm: w.nm, ebTier, gbTier, diff, tag: w.tag, share: gb?.share });
  }
  rows.sort((a,b) => a.diff - b.diff);
  for(const r of rows){
    const arrow = r.diff === 0 ? '=' : (r.diff > 0 ? `+${r.diff}` : String(r.diff));
    const shareTxt = r.share ? `(${r.share.toFixed(4)}%)` : '(hors top 1000)';
    console.log(`${r.nm.padEnd(28)}|   ${r.ebTier}    |   ${r.gbTier}   |  ${arrow.padStart(3)}  | ${r.tag} ${shareTxt}`);
  }

  // Stats globales.
  const nSame = diffs.filter(d => d === 0).length;
  const nAdj = diffs.filter(d => Math.abs(d) === 1).length;
  const nWide = diffs.filter(d => Math.abs(d) >= 2).length;
  const mean = diffs.reduce((s,d)=>s+d,0) / diffs.length;
  const positive = diffs.filter(d => d > 0).length;
  const negative = diffs.filter(d => d < 0).length;
  console.log('\n' + '='.repeat(120));
  console.log('Stats globales :');
  console.log(`  Meme tier            : ${nSame}/${diffs.length} (${(nSame/diffs.length*100).toFixed(0)}%)`);
  console.log(`  Ecart 1 tier         : ${nAdj}/${diffs.length} (${(nAdj/diffs.length*100).toFixed(0)}%)`);
  console.log(`  Ecart >= 2 tiers     : ${nWide}/${diffs.length} (${(nWide/diffs.length*100).toFixed(0)}%)`);
  console.log(`  Ecart moyen (GBIF - eBird) : ${mean.toFixed(2)} (positif = GBIF plus rare)`);
  console.log(`  GBIF plus rare (diff > 0)  : ${positive}`);
  console.log(`  GBIF plus commun (diff < 0): ${negative}`);
  console.log('='.repeat(120));
  console.log('\nInterpretation :');
  console.log('  - Ecart moyen ~0    -> pas de biais systematique, on peut basculer.');
  console.log('  - Ecart moyen +2-3  -> GBIF sous-classe les cryptiques (photo bias). Garder eBird pour wild.');
  console.log('  - Ecart moyen -2-3  -> GBIF sur-classe les urbains (photo bias). Garder eBird pour wild.');
}

main().catch(err => { console.error(err); process.exit(1); });
