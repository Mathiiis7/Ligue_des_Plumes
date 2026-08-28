#!/usr/bin/env node
/*
  download-bar-charts-uk-counties.mjs
  Fetch bar chart eBird pour les 49 English counties (admin2 GB-ENG-*).
  Puis agrege par region ONS (9 regions) via weighted-average (uniform weight).
  Sortie : tools/uk-ons-regions-freq.json puis merge dans data/freq_by_region_gb.json

  Usage : EBIRD_COOKIE="xxx" node tools/download-bar-charts-uk-counties.mjs
*/
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const COOKIE = process.env.EBIRD_COOKIE;
if (!COOKIE) { console.error('EBIRD_COOKIE non set'); process.exit(1); }

// Mapping des 49 English counties (eBird admin2) vers 9 regions ONS
const COUNTY_TO_ONS_REGION = {
  'GB-ENG-BDF': 'GB-EE',  'GB-ENG-BRC': 'GB-SE', 'GB-ENG-BST': 'GB-SW',
  'GB-ENG-BKM': 'GB-SE',  'GB-ENG-CAM': 'GB-EE', 'GB-ENG-CHS': 'GB-NW',
  'GB-ENG-CON': 'GB-SW',  'GB-ENG-CMA': 'GB-NW', 'GB-ENG-DBY': 'GB-EM',
  'GB-ENG-DEV': 'GB-SW',  'GB-ENG-DOR': 'GB-SW', 'GB-ENG-DUR': 'GB-NE',
  'GB-ENG-ERY': 'GB-YH',  'GB-ENG-ESX': 'GB-SE', 'GB-ENG-ESS': 'GB-EE',
  'GB-ENG-GLS': 'GB-SW',  'GB-ENG-HAL': 'GB-NW', 'GB-ENG-HAM': 'GB-SE',
  'GB-ENG-HEF': 'GB-WM',  'GB-ENG-HRT': 'GB-EE', 'GB-ENG-IOW': 'GB-SE',
  'GB-ENG-KEN': 'GB-SE',  'GB-ENG-LAN': 'GB-NW', 'GB-ENG-LEC': 'GB-EM',
  'GB-ENG-LIN': 'GB-EM',  'GB-ENG-LND': 'GB-LON','GB-ENG-MAN': 'GB-NW',
  'GB-ENG-KWL': 'GB-NW',  'GB-ENG-NFK': 'GB-EE', 'GB-ENG-NYK': 'GB-YH',
  'GB-ENG-NTH': 'GB-EM',  'GB-ENG-NBL': 'GB-NE', 'GB-ENG-NTT': 'GB-EM',
  'GB-ENG-OXF': 'GB-SE',  'GB-ENG-RUT': 'GB-EM', 'GB-ENG-SHR': 'GB-WM',
  'GB-ENG-SOM': 'GB-SW',  'GB-ENG-BNS': 'GB-YH', 'GB-ENG-STS': 'GB-WM',
  'GB-ENG-STT': 'GB-NE',  'GB-ENG-SFK': 'GB-EE', 'GB-ENG-SRY': 'GB-SE',
  'GB-ENG-GAT': 'GB-NE',  'GB-ENG-WAR': 'GB-WM', 'GB-ENG-SAW': 'GB-WM',
  'GB-ENG-WSX': 'GB-SE',  'GB-ENG-WKF': 'GB-YH', 'GB-ENG-WIL': 'GB-SW',
  'GB-ENG-WOR': 'GB-WM',
};

const ONS_REGION_NAMES = {
  'GB-SW':  'South West (Anglia)',
  'GB-SE':  'South East (Anglia)',
  'GB-LON': 'Grand Londres',
  'GB-EE':  'East of England',
  'GB-EM':  'East Midlands',
  'GB-WM':  'West Midlands',
  'GB-YH':  'Yorkshire and the Humber',
  'GB-NW':  'North West England',
  'GB-NE':  'North East England',
};

const counties = Object.keys(COUNTY_TO_ONS_REGION);
console.log('Total counties a fetcher :', counties.length);

const SLEEP_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function urlFor(region) {
  const params = new URLSearchParams({
    byr: '2019', eyr: '2026', bmo: '1', emo: '12',
    r: region, fmt: 'tsv',
  });
  return `https://ebird.org/barchartData?${params.toString()}`;
}

async function fetchOne(county) {
  try {
    const r = await fetch(urlFor(county), {
      headers: {
        'Cookie': `EBIRD_SESSIONID=${COOKIE}`,
        'Accept': 'text/tab-separated-values,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (birdlist-app/1.0)',
      },
      redirect: 'follow',
    });
    if (!r.ok) return { county, ok: false, err: `HTTP ${r.status}` };
    const text = await r.text();
    if (text.startsWith('<') || text.length < 500) {
      return { county, ok: false, err: `Contenu suspect (cookie?), taille ${text.length}` };
    }
    return { county, ok: true, text };
  } catch (e) {
    return { county, ok: false, err: e.message };
  }
}

// Parse bar chart TSV eBird : lignes species + 48 quinzaines de valeurs
// Format : sciName<TAB>commonName<TAB>freq_period_1<TAB>...<TAB>freq_period_48
// Retourne { sciName: [freq_period_1..48] }
function parseBarChart(tsv) {
  const lines = tsv.split('\n');
  // Skip header: chercher la premiere ligne data (contient tabs et un sci name)
  const out = {};
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 50) continue;
    // parts[0] = commonName (parfois), parts[1] = sciName (souvent) OR autre ordering
    // Format observe : la 1ere colonne est comName, la 2eme sciName (ou premiere ligne = header)
    // Trouvons via detection : si part contient "spuh" ou " sp." on skip
    const sci = parts[0].toLowerCase().trim();
    if (!sci || sci.includes(' sp.') || sci.includes(' x ') || sci.startsWith('#')) continue;
    // 48 valeurs 2-49 sont les periodes biweekly
    const freq = [];
    for (let i = 1; i <= 48; i++) {
      const v = parseFloat(parts[i]);
      freq.push(isNaN(v) ? 0 : v);
    }
    if (freq.length === 48) out[sci] = freq;
  }
  return out;
}

// Convert 48 biweekly periods to 12 monthly averages
function biweeklyToMonthly(freq48) {
  const monthly = new Array(12).fill(0);
  for (let m = 0; m < 12; m++) {
    // Chaque mois = 4 periodes biweekly (index 4m, 4m+1, 4m+2, 4m+3)
    let sum = 0, n = 0;
    for (let k = 0; k < 4; k++) {
      const p = m * 4 + k;
      if (p < 48) { sum += freq48[p]; n++; }
    }
    monthly[m] = n > 0 ? sum / n : 0;
  }
  return monthly;
}

// === Fetch all counties ===
const results = {};   // { county: { sci: [freq48] } }
const errors = [];
for (let i = 0; i < counties.length; i++) {
  const c = counties[i];
  process.stdout.write(`  [${i+1}/${counties.length}] ${c}... `);
  const r = await fetchOne(c);
  if (!r.ok) {
    console.log('ERR:', r.err);
    errors.push(r);
    await sleep(SLEEP_MS);
    continue;
  }
  const parsed = parseBarChart(r.text);
  results[c] = parsed;
  console.log(`${Object.keys(parsed).length} especes`);
  await sleep(SLEEP_MS);
}

console.log(`\n=== Fetch termine. ${Object.keys(results).length} counties OK, ${errors.length} erreurs. ===`);

// === Aggregation par region ONS (moyenne simple des counties du groupe) ===
const regionData = {};   // { GB-XX: { sci: [monthly12] } }
for (const rc of Object.keys(ONS_REGION_NAMES)) regionData[rc] = {};

// Collecte des species par region
const bySpeciesRegion = {};   // { GB-XX: { sci: [monthly-cumul, count] } }
for (const rc of Object.keys(ONS_REGION_NAMES)) bySpeciesRegion[rc] = {};

for (const [county, spData] of Object.entries(results)) {
  const region = COUNTY_TO_ONS_REGION[county];
  if (!region) continue;
  for (const [sci, freq48] of Object.entries(spData)) {
    const monthly = biweeklyToMonthly(freq48);
    if (!bySpeciesRegion[region][sci]) {
      bySpeciesRegion[region][sci] = { sum: new Array(12).fill(0), count: 0 };
    }
    const e = bySpeciesRegion[region][sci];
    for (let m = 0; m < 12; m++) e.sum[m] += monthly[m];
    e.count++;
  }
}

// Compute weighted average
for (const rc of Object.keys(ONS_REGION_NAMES)) {
  for (const [sci, e] of Object.entries(bySpeciesRegion[rc])) {
    regionData[rc][sci] = e.sum.map(v => Math.round(v / e.count * 1e5) / 1e5);
  }
}

// === Merge dans data/freq_by_region_gb.json ===
const targetPath = join(ROOT, 'data', 'freq_by_region_gb.json');
let existing = {};
try { existing = JSON.parse(readFileSync(targetPath, 'utf8')); } catch {}
for (const [rc, data] of Object.entries(regionData)) {
  existing[rc] = data;
}

writeFileSync(targetPath, JSON.stringify(existing));
console.log(`\nMerge dans ${targetPath}`);
for (const rc of Object.keys(ONS_REGION_NAMES)) {
  console.log(`  ${rc} (${ONS_REGION_NAMES[rc]}) : ${Object.keys(regionData[rc]).length} especes`);
}

// === Erreurs ===
if (errors.length) {
  console.log('\n=== Erreurs ===');
  for (const e of errors) console.log(`  ${e.county} : ${e.err}`);
}
