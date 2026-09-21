#!/usr/bin/env node
/*
  build-rarity-multi-country.mjs - Regenere tier + monthly bar chart pour ES/IT/GB/PT
  (les 4 pays sans bar chart pour le moment). Same logic que build-rarity-me-ebird.mjs
  mais parametrisee.

  Bar charts en francais (locale=fr) : parseur identique a FR/ME.
  eBird taxonomy API : matche noms FR -> sciName.

  Sortie par pays :
    tools/real-rarity-{XX}-ebird.generated.js : { REAL_RARITY_{XX}_EBIRD, REAL_FREQ_MONTHLY_{XX} }

  Usage : node tools/build-rarity-multi-country.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const COUNTRIES = ['ES', 'IT', 'GB', 'PT', 'CH', 'NO', 'GR', 'IS', 'LK', 'NA'];

// Regions par pays (admin1 eBird). Ajoute la data monthly par region -> alimente
// data/freq_by_region_XX.json pour lazy-load runtime (comme FR).
const REGIONS = {
  GB: ['GB-ENG', 'GB-SCT', 'GB-WLS', 'GB-NIR'],
  PT: ['PT-01', 'PT-02', 'PT-03', 'PT-04', 'PT-05', 'PT-06', 'PT-07',
       'PT-08', 'PT-09', 'PT-10', 'PT-11', 'PT-12', 'PT-13', 'PT-14',
       'PT-15', 'PT-16', 'PT-17', 'PT-18', 'PT-20', 'PT-30'],
  ES: ['ES-AN', 'ES-AR', 'ES-AS', 'ES-CB', 'ES-CE', 'ES-CL', 'ES-CM',
       'ES-CN', 'ES-CT', 'ES-EX', 'ES-GA', 'ES-IB', 'ES-MC', 'ES-MD',
       'ES-ML', 'ES-NC', 'ES-PV', 'ES-RI', 'ES-VC'],
  IT: ['IT-21', 'IT-23', 'IT-25', 'IT-32', 'IT-34', 'IT-36', 'IT-42',
       'IT-45', 'IT-52', 'IT-55', 'IT-57', 'IT-62', 'IT-65', 'IT-67',
       'IT-72', 'IT-75', 'IT-77', 'IT-78', 'IT-82', 'IT-88'],
  // Ajouts 2026-09-21 : CH/NO/GR/IS/LK/NA.
  CH: ['CH-AG','CH-AI','CH-AR','CH-BE','CH-BL','CH-BS','CH-FR','CH-GE',
       'CH-GL','CH-GR','CH-JU','CH-LU','CH-NE','CH-NW','CH-OW','CH-SG',
       'CH-SH','CH-SO','CH-SZ','CH-TG','CH-TI','CH-UR','CH-VD','CH-VS',
       'CH-ZG','CH-ZH'],
  NO: ['NO-01','NO-02','NO-03','NO-04','NO-05','NO-06','NO-07','NO-08',
       'NO-09','NO-10','NO-11','NO-12','NO-14','NO-15','NO-16','NO-17',
       'NO-18','NO-19','NO-20'],
  GR: ['GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I',
       'GR-J','GR-K','GR-L','GR-M'],
  IS: ['IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8'],
  LK: ['LK-11','LK-12','LK-13','LK-21','LK-22','LK-23','LK-31','LK-32',
       'LK-33','LK-41','LK-42','LK-43','LK-44','LK-45','LK-51','LK-52',
       'LK-53','LK-61','LK-62','LK-71','LK-72','LK-81','LK-82','LK-91',
       'LK-92'],
  NA: ['NA-CA','NA-ER','NA-HA','NA-KA','NA-KH','NA-KU','NA-OD','NA-OH',
       'NA-OK','NA-ON','NA-OS','NA-OT','NA-OW'],
};

// Memes seuils que FR/ME (Option 1 recalibree 2026-08-27, tier 10 seuil 0.00015)
const THRESHOLDS = [
  [0.25, 1], [0.15, 2], [0.08, 3], [0.04, 4],
  [0.02, 5], [0.007, 6], [0.0015, 7], [0.0003, 8],
  [0.00015, 9],
];
function weightFor(freq){ for(const [min, w] of THRESHOLDS) if(freq >= min) return w; return 10; }

const norm = s => s.toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]/g, '');

// Alias generaux : nom UI bar chart -> nom API (CINFO long). Meme table que ME.
const BAR_CHART_ALIAS = {
  'Grand Gravelot': 'Pluvier grand-gravelot',
  'Petit Gravelot': 'Pluvier petit-gravelot',
  'Gravelot à collier interrompu': 'Pluvier à collier interrompu',
  'Gravelot semipalmé': 'Pluvier semipalmé',
  'Gravelot kildir': 'Pluvier kildir',
  'Gravelot de Leschenault': 'Pluvier de Leschenault',
  'Gravelot asiatique': 'Pluvier asiatique',
  'Guignard d’Eurasie': 'Pluvier guignard',
  'Guignard d\'Eurasie': 'Pluvier guignard',
  'Harle bièvre': 'Grand Harle',
};

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
    // 48 quinzaines -> 12 mois (max des 4 quinzaines par mois)
    const m12 = new Array(12).fill(0);
    for(let m = 0; m < 12; m++){
      const start = m * 4;
      m12[m] = Math.max(nums[start]||0, nums[start+1]||0, nums[start+2]||0, nums[start+3]||0);
    }
    out[norm(canonical)] = { name: canonical, freq: Math.max(...nums), monthly: m12 };
  }
  return out;
}

// Cache taxonomy eBird (partagee pour les 4 pays)
let TAXONOMY_CACHE = null;
async function fetchTaxonomy(){
  if(TAXONOMY_CACHE) return TAXONOMY_CACHE;
  console.log('Fetching eBird taxonomy (locale=fr)...');
  const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
    headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
  })).json();
  TAXONOMY_CACHE = {};   // norm(comName) -> sciName lowercase
  for(const t of tax) if(t.sciName && t.comName) TAXONOMY_CACHE[norm(t.comName)] = t.sciName.toLowerCase();
  console.log(`Taxonomy : ${tax.length} especes.`);
  return TAXONOMY_CACHE;
}

const BAR_DIR = join(__dir, '..', 'ebird-barcharts-raw');
const OUT_DIR = join(__dir, '..', '..', 'data', 'generated');

async function processCountry(cc){
  const barPath = join(BAR_DIR, `ebird-barchart-${cc}-2019-2026.txt`);
  const outPath = join(OUT_DIR, `real-rarity-${cc.toLowerCase()}-ebird.generated.js`);

  console.log(`\n=== ${cc} ===`);
  const bar = parseBarchart(barPath);
  console.log(`  Bar chart : ${Object.keys(bar).length} taxons`);

  const tax = await fetchTaxonomy();
  const rarity = {}, monthly = {};
  let matched = 0, unmatched = 0;
  const unmatchedList = [];
  for(const [k, { name, freq, monthly: m12 }] of Object.entries(bar)){
    const sci = tax[k];
    if(sci){
      rarity[sci] = weightFor(freq);
      monthly[sci] = m12.map(v => +v.toFixed(5));
      matched++;
    } else { unmatched++; unmatchedList.push(name); }
  }
  console.log(`  Matched : ${matched}, unmatched : ${unmatched}`);
  if(unmatchedList.length > 0){
    console.log(`  Sample unmatched : ${unmatchedList.slice(0, 5).join(', ')}${unmatchedList.length > 5 ? '...' : ''}`);
  }

  const distr = {1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0};
  for(const w of Object.values(rarity)) distr[w]++;
  console.log('  Distribution :', JSON.stringify(distr));

  const content = `// Genere par tools/build-rarity-multi-country.mjs depuis le bar chart eBird ${cc}.\n` +
                  `// Ne pas editer a la main.\n` +
                  `export const REAL_RARITY_${cc}_EBIRD = ${JSON.stringify(rarity)};\n` +
                  `export const REAL_FREQ_MONTHLY_${cc} = ${JSON.stringify(monthly)};\n`;
  writeFileSync(outPath, content);
  console.log(`  Ecrit : ${outPath} (${content.length} chars)`);

  // Regional : pour chaque region, parse le bar chart et extract les monthly par sci.
  // Alimente data/freq_by_region_XX.json (structure : { region: { sci: [12] } }).
  const regionalData = {};
  let nRegionsFound = 0;
  for (const regCode of REGIONS[cc] || []) {
    const barRegPath = join(BAR_DIR, `ebird-barchart-${regCode}-2019-2026.txt`);
    try {
      const barReg = parseBarchart(barRegPath);
      const regMap = {};
      for (const [k, { monthly: m12 }] of Object.entries(barReg)) {
        const sci = tax[k];
        if (sci) regMap[sci] = m12.map(v => +v.toFixed(5));
      }
      if (Object.keys(regMap).length > 0) {
        regionalData[regCode] = regMap;
        nRegionsFound++;
      }
    } catch (err) {
      console.warn(`  ! ${regCode} : ${err.message}`);
    }
  }
  const regJson = JSON.stringify(regionalData);
  // Path attendu par l'app : data/countries/xx/freq_by_region.json
  const countryDir = join(__dir, '..', '..', 'data', 'countries', cc.toLowerCase());
  const { mkdirSync } = await import('node:fs');
  mkdirSync(countryDir, { recursive: true });
  const regPath = join(countryDir, `freq_by_region.json`);
  writeFileSync(regPath, regJson);
  console.log(`  Ecrit : ${regPath} (${regJson.length} chars, ${nRegionsFound} regions)`);
}

for(const cc of COUNTRIES){
  await processCountry(cc);
}
console.log('\nTermine.');
