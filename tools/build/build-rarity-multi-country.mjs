#!/usr/bin/env node
/*
  build-rarity-multi-country.mjs - Regenere tier + monthly bar chart pour ES/IT/GB/PT
  (les 4 pays sans bar chart pour le moment). Same logic que build-rarity-me-ebird.mjs
  mais parametrisee.

  Bar charts en francais (locale=fr_FR) : parseur identique a FR/ME.
  eBird taxonomy API : matche noms FR -> sciName.

  Sortie par pays :
    tools/real-rarity-{XX}-ebird.generated.js : { REAL_RARITY_{XX}_EBIRD, REAL_FREQ_MONTHLY_{XX} }

  Usage : node tools/build-rarity-multi-country.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const COUNTRIES = ['FR', 'ES', 'IT', 'GB', 'PT', 'CH', 'NO', 'GR', 'IS', 'LK', 'NA', 'AU', 'NZ', 'US', 'CA'];

// La France est passee sur ce generateur le 2026-09-23. Elle dependait jusque-la de
// build-rarity-ebird.mjs, devenu obsolete : il lisait FR_NAMES depuis index.html (la table
// vit dans app.js depuis le decoupage), appariait les anciens noms nord-americains contre un
// bar chart europeen, et plafonnait a 9 tiers avec des seuils qui lui etaient propres
// (0,35 / 0,20 / 0,10...). Les tiers francais avaient ete recalibres depuis sur l'echelle
// commune a 10 tiers, mais par un chemin qui n'etait plus celui du script.
//
// Trois particularites francaises, d'ou les tables ci-dessous :
//   - l'app nomme ses tables REAL_RARITY et REAL_FREQ_MONTHLY, sans suffixe de pays ;
//   - les bar charts regionaux FR couvrent 2015-2026 la ou tout le reste est sur 2019-2026 ;
//   - REAL_RARITY porte 8 anciennes cles de genre (bubulcus ibis, accipiter gentilis...) qui
//     n'ont pas d'entree dans SCI_ALIAS : du code peut les interroger directement, elles sont
//     conservees par fusion a l'injection plutot que perdues au rebuild.
const NOMS_TABLES = {
  FR: { rarete: 'REAL_RARITY', mensuel: 'REAL_FREQ_MONTHLY' },
};
const nomRarete = cc => (NOMS_TABLES[cc] && NOMS_TABLES[cc].rarete) || ('REAL_RARITY_' + cc + '_EBIRD');
const nomMensuel = cc => (NOMS_TABLES[cc] && NOMS_TABLES[cc].mensuel) || ('REAL_FREQ_MONTHLY_' + cc);

// Fenetre des bar charts regionaux, quand elle differe du national.
const FENETRE_REGIONS = { FR: '2015-2026' };
const fenetreRegion = cc => FENETRE_REGIONS[cc] || '2019-2026';

// Regions par pays (admin1 eBird). Ajoute la data monthly par region -> alimente
// data/freq_by_region_XX.json pour lazy-load runtime (comme FR).
const REGIONS = {
// La France est volontairement absente de cette table. Son data/countries/fr/
// freq_by_region.json contient 109 zones — les 13 regions ET les 96 departements — pour
// 29 298 series, alors que seuls les bar charts des 13 regions existent en local.
// Regenerer depuis ici ecraserait le fichier avec 13 zones et 4 780 series, faisant
// disparaitre toutes les cartes departementales. Le national FR est bien produit ici,
// le regional reste sur sa source d origine.
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
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  NZ: ['NZ-AUK','NZ-BOP','NZ-CAN','NZ-CI','NZ-GIS','NZ-HKB','NZ-MWT','NZ-MBH',
       'NZ-NSN','NZ-NTL','NZ-OTA','NZ-STL','NZ-TKI','NZ-TAS','NZ-WKO','NZ-WGN',
       'NZ-WTC'],
  US: ['US-AL','US-AK','US-AZ','US-AR','US-CA','US-CO','US-CT','US-DE','US-DC',
       'US-FL','US-GA','US-HI','US-ID','US-IL','US-IN','US-IA','US-KS','US-KY',
       'US-LA','US-ME','US-MD','US-MA','US-MI','US-MN','US-MS','US-MO','US-MT',
       'US-NE','US-NV','US-NH','US-NJ','US-NM','US-NY','US-NC','US-ND','US-OH',
       'US-OK','US-OR','US-PA','US-RI','US-SC','US-SD','US-TN','US-TX','US-UT',
       'US-VT','US-VA','US-WA','US-WV','US-WI','US-WY'],
  CA: ['CA-AB','CA-BC','CA-MB','CA-NB','CA-NL','CA-NT','CA-NS','CA-NU','CA-ON',
       'CA-PE','CA-QC','CA-SK','CA-YT'],
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

// Repli de nommage : nom du bar chart -> autre nom API possible.
//
// Ces alias datent de l'epoque ou la taxonomie etait interrogee en locale=fr, qui renvoie la
// nomenclature nord-americaine (Pluvier grand-gravelot, Grand Harle). Les bar charts europeens
// utilisent la nomenclature europeenne (Grand Gravelot, Harle bievre). Depuis le passage a
// locale=fr_FR l'API parle la meme langue que les bar charts : ces alias ne servent plus qu'en
// secours, essayes UNIQUEMENT si le nom brut ne matche pas. Les appliquer d'office faisait
// l'inverse du travail attendu et perdait silencieusement les especes concernees.
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
    // 48 quinzaines -> 12 mois (max des 4 quinzaines par mois)
    const m12 = new Array(12).fill(0);
    for(let m = 0; m < 12; m++){
      const start = m * 4;
      m12[m] = Math.max(nums[start]||0, nums[start+1]||0, nums[start+2]||0, nums[start+3]||0);
    }
    out[norm(clean)] = { name: clean, freq: Math.max(...nums), monthly: m12 };
  }
  return out;
}

// Cache taxonomy eBird (partagee pour les 4 pays)
let TAXONOMY_CACHE = null;
async function fetchTaxonomy(){
  if(TAXONOMY_CACHE) return TAXONOMY_CACHE;
  console.log('Fetching eBird taxonomy (locale=fr_FR)...');
  const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species', {
    headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
  })).json();
  TAXONOMY_CACHE = {};   // norm(comName) -> sciName lowercase
  for(const t of tax) if(t.sciName && t.comName) TAXONOMY_CACHE[norm(t.comName)] = t.sciName.toLowerCase();
  console.log(`Taxonomy : ${tax.length} especes.`);
  return TAXONOMY_CACHE;
}

// Nom brut d'abord, alias en secours (voir BAR_CHART_ALIAS).
function resolveSci(tax, k, name){
  const direct = tax[k];
  if(direct) return direct;
  const al = BAR_CHART_ALIAS[name];
  return al ? tax[norm(al)] : undefined;
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
    const sci = resolveSci(tax, k, name);
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
                  `export const ${nomRarete(cc)} = ${JSON.stringify(rarity)};\n` +
                  `export const ${nomMensuel(cc)} = ${JSON.stringify(monthly)};\n`;
  writeFileSync(outPath, content);
  console.log(`  Ecrit : ${outPath} (${content.length} chars)`);

  // Regional : pour chaque region, parse le bar chart et extract les monthly par sci.
  // Alimente data/freq_by_region_XX.json (structure : { region: { sci: [12] } }).
  const regionalData = {};
  let nRegionsFound = 0;
  for (const regCode of REGIONS[cc] || []) {
    const barRegPath = join(BAR_DIR, `ebird-barchart-${regCode}-${fenetreRegion(cc)}.txt`);
    try {
      const barReg = parseBarchart(barRegPath);
      const regMap = {};
      for (const [k, { name, monthly: m12 }] of Object.entries(barReg)) {
        const sci = resolveSci(tax, k, name);
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
  // Garde-fou : ne jamais remplacer un fichier regional existant par un plus pauvre. Une
  // fenetre de TSV mal nommee ou une region non telechargee produirait sinon une perte
  // silencieuse — c est ce qui a failli effacer les 96 departements francais.
  const { existsSync } = await import('node:fs');
  let ancienNb = 0;
  if (existsSync(regPath)) {
    try { ancienNb = Object.keys(JSON.parse(readFileSync(regPath, 'utf8'))).length; } catch (e) {}
  }
  if (nRegionsFound < ancienNb) {
    console.warn(`  ! ${regPath} conserve : ${ancienNb} zones deja presentes contre ${nRegionsFound} produites.`);
  } else {
    writeFileSync(regPath, regJson);
    console.log(`  Ecrit : ${regPath} (${regJson.length} chars, ${nRegionsFound} regions)`);
  }
}

for(const cc of COUNTRIES){
  await processCountry(cc);
}
console.log('\nTermine.');
