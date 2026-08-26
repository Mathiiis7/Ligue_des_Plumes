#!/usr/bin/env node
/*
  build-rarity-me-ebird.mjs — Rareté ME depuis le bar chart eBird (comme la FR).

  Utilise ebird-barchart-ME-2015-2026.txt téléchargé depuis
  https://ebird.org/barchart?byr=2015&eyr=2026&r=ME

  Sortie : tools/real-rarity-me-ebird.generated.js
  Aussi : diff avec REAL_RARITY_ME (GBIF) pour évaluer l'écart.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const BARCHART = join(__dir, 'ebird-barchart-ME-2019-2026.txt');
const OUT = join(__dir, 'real-rarity-me-ebird.generated.js');
const GBIF_ME = join(__dir, 'real-rarity-me.generated.js');

// Mêmes seuils que FR (bar chart eBird = même unité : % listes).
// Mêmes seuils que FR (Option 1 recalibré 2026-08-27) — voir build-rarity-ebird.mjs.
const THRESHOLDS = [
  [0.25, 1], [0.15, 2], [0.08, 3], [0.04, 4],
  [0.02, 5], [0.007, 6], [0.0015, 7], [0.0003, 8],
  [0.00005, 9],
];
function weightFor(freq){ for(const [min, w] of THRESHOLDS) if(freq >= min) return w; return 10; }

const norm = s => s.toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]/g, '');

// Alias FR name du bar chart -> FR name que retourne eBird taxonomy API (locale=fr).
// Le bar chart utilise les noms courts UI (Grand Gravelot), l'API retourne les noms
// CINFO longs (Pluvier grand-gravelot). Sans cet alias, ~30 especes du bar chart ME
// ne sont pas matchees vers un sciName.
// Ces aliases mappent le nom UI du bar chart -> le nom retourne par eBird taxonomy API
// (locale=fr). La plupart des especes ont le meme nom des deux cotes ; seules quelques
// unes ont un raccourci UI different du nom CINFO long. Attention : ne PAS confondre
// avec les alias FR_NAMES (nom app) -> API : ici c'est bar chart -> API.
const BAR_CHART_ALIAS = {
  'Grand Gravelot': 'Pluvier grand-gravelot',
  'Petit Gravelot': 'Pluvier petit-gravelot',
  'Gravelot à collier interrompu': 'Pluvier à collier interrompu',
  'Gravelot semipalmé': 'Pluvier semipalmé',
  'Gravelot kildir': 'Pluvier kildir',
  'Gravelot de Leschenault': 'Pluvier de Leschenault',
  'Gravelot asiatique': 'Pluvier asiatique',
  'Guignard d’Eurasie': 'Pluvier guignard',   // apostrophe typographique dans le bar chart
  'Guignard d\'Eurasie': 'Pluvier guignard',
  'Harle bièvre': 'Grand Harle',
};
// 1) Parse bar chart : FR name -> freq peak. Applique BAR_CHART_ALIAS si necessaire pour
// que le norm() du nom bar chart matche celui de l'eBird taxonomy API.
function parseBarchart(path){
  const out = {};
  for(const ln of readFileSync(path, 'utf8').split(/\r?\n/)){
    if(!ln.includes('\t')) continue;
    const p = ln.split('\t');
    const nm = p[0].trim();
    const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
    if(!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
    const clean = nm.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    const canonical = BAR_CHART_ALIAS[clean] || clean;
    // 48 quinzaines = 4 par mois. Pic mensuel = max des 4 quinzaines. Format identique
    // a REAL_FREQ_MONTHLY FR pour cohérence de rendu (12 valeurs [0..1]).
    const m12 = new Array(12).fill(0);
    for(let m = 0; m < 12; m++){
      const start = m * 4;
      m12[m] = Math.max(nums[start]||0, nums[start+1]||0, nums[start+2]||0, nums[start+3]||0);
    }
    out[norm(canonical)] = { name: canonical, freq: Math.max(...nums), monthly: m12 };
  }
  return out;
}
const bar = parseBarchart(BARCHART);
console.log(`Bar chart ME : ${Object.keys(bar).length} taxons.`);

// 2) Fetch eBird taxonomy pour mapper FR name -> sciName.
console.log('Fetching eBird taxonomy (locale=fr) ...');
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
  headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
})).json();
const frToSci = {};   // norm(comName FR) -> sciName lowercase
for(const t of tax) if(t.sciName && t.comName) frToSci[norm(t.comName)] = t.sciName.toLowerCase();
console.log(`Taxonomy eBird : ${tax.length} especes.`);

// 3) Croise bar chart -> REAL_RARITY_ME_EBIRD + REAL_FREQ_MONTHLY_ME.
const map = {};
const monthly = {};
let matched = 0, unmatched = 0;
const unmatchedList = [];
for(const [k, {name, freq, monthly:m12}] of Object.entries(bar)){
  const sci = frToSci[k];
  if(sci){
    map[sci] = weightFor(freq);
    // Arrondi 5 decimales pour reduire la taille en cache (comme FR).
    monthly[sci] = m12.map(v => +v.toFixed(5));
    matched++;
  } else { unmatched++; unmatchedList.push(name); }
}
console.log(`Matched : ${matched}/${matched+unmatched}. Unmatched sample:`, unmatchedList.slice(0, 10));

const distr = {1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0};
for(const w of Object.values(map)) distr[w]++;
console.log('Distribution eBird :');
for(const [k,v] of Object.entries(distr)) console.log(`  tier ${k} : ${v}`);

writeFileSync(OUT,
  `// Genere par tools/build-rarity-me-ebird.mjs depuis le bar chart eBird ME.\n` +
  `// Ne pas editer a la main.\n` +
  `export const REAL_RARITY_ME_EBIRD = ${JSON.stringify(map)};\n` +
  `export const REAL_FREQ_MONTHLY_ME = ${JSON.stringify(monthly)};\n`);
console.log(`✓ Ecrit ${OUT} (${Object.keys(map).length} especes, monthly + rarity).`);

// 4) Compare avec REAL_RARITY_ME (GBIF).
try{
  const gbifSrc = readFileSync(GBIF_ME, 'utf8');
  const gbifM = eval(gbifSrc.replace('export const', 'const') + '; REAL_RARITY_ME');
  const shared = Object.keys(map).filter(sci => sci in gbifM);
  let sameTier = 0, adjacent = 0, wideDiff = 0;
  const diffs = [];
  for(const sci of shared){
    const d = Math.abs(map[sci] - gbifM[sci]);
    if(d === 0) sameTier++;
    else if(d === 1) adjacent++;
    else wideDiff++;
    if(d >= 2) diffs.push({ sci, ebird: map[sci], gbif: gbifM[sci] });
  }
  console.log(`\n=== COMPARAISON eBird vs GBIF sur ${shared.length} especes communes ===`);
  console.log(`  Meme tier : ${sameTier} (${(sameTier/shared.length*100).toFixed(1)}%)`);
  console.log(`  Adjacent (+/- 1 tier) : ${adjacent} (${(adjacent/shared.length*100).toFixed(1)}%)`);
  console.log(`  Ecart >= 2 tiers : ${wideDiff} (${(wideDiff/shared.length*100).toFixed(1)}%)`);
  console.log(`\nExemples d'ecarts significatifs (top 15) :`);
  diffs.sort((a,b) => Math.abs(b.ebird-b.gbif) - Math.abs(a.ebird-a.gbif));
  for(const d of diffs.slice(0, 15)) console.log(`  ${d.sci}: eBird ${d.ebird} vs GBIF ${d.gbif}`);
}catch(err){ console.log('Comparaison impossible :', err.message); }
