#!/usr/bin/env node
/*
  enrich-redlist-global.mjs - Complete tools/redlist.json avec le statut
  IUCN Global des especes manquantes, via l'API GBIF.

  Redlist.json actuel = base Liste Rouge FR 2016 + statut global des ~645 especes FR.
  Manquantes : les endemiques et especes non-FR presentes dans S&T ES/IT/GB/PT/ME
  (Cyanopica cooki, sous-especes Corse, endemiques ibériques, etc.).

  Approche :
    1. Charge tous les sci names des dicts S&T par pays + REAL_RARITY_XX_EBIRD
    2. Filtre ceux absents de REDLIST ou dont REDLIST.global est manquant
    3. Pour chaque : GBIF /species/match -> usageKey -> /iucnRedListCategory
    4. Ecrit redlist.json enrichie (garde les FR existants, ajoute global manquants)

  Rate limit : 100ms entre requetes GBIF (courtois). ~500 species -> ~1 min compute.
  Usage : node tools/enrich-redlist-global.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const REDLIST_PATH = join(__dir, 'redlist.json');
const HTML_PATH = join(ROOT, 'index.html');

const redlist = JSON.parse(readFileSync(REDLIST_PATH, 'utf8'));
console.log('Redlist initial :', Object.keys(redlist).length, 'especes');

// Collecte tous les sci names des data injectees dans index.html
const html = readFileSync(HTML_PATH, 'utf8');
const allSci = new Set();

// From REAL_ABUNDANCE_ST_XX (6 pays) et REAL_RARITY_XX_EBIRD (5 pays avec bar chart)
const varsToCheck = [
  'REAL_ABUNDANCE_ST_FR', 'REAL_ABUNDANCE_ST_ME',
  'REAL_ABUNDANCE_ST_ES', 'REAL_ABUNDANCE_ST_IT',
  'REAL_ABUNDANCE_ST_GB', 'REAL_ABUNDANCE_ST_PT',
  'REAL_RARITY_ME_EBIRD', 'REAL_RARITY_ES_EBIRD',
  'REAL_RARITY_IT_EBIRD', 'REAL_RARITY_GB_EBIRD',
  'REAL_RARITY_PT_EBIRD', 'REAL_RARITY',
];
for (const v of varsToCheck) {
  const m = html.match(new RegExp('const ' + v + ' = (\\{.*?\\});', 's'));
  if (m) {
    try {
      const d = JSON.parse(m[1]);
      for (const sci in d) allSci.add(sci);
    } catch (e) { console.warn(v, ':', e.message); }
  }
}
console.log('Especes uniques trouvees dans data 6 pays :', allSci.size);

// Filter : celles absentes de REDLIST ou avec global manquant/NE
const missing = [...allSci].filter(sci => {
  const e = redlist[sci];
  if (!e) return true;
  if (!e.global || e.global === 'NE') return true;
  return false;
});
console.log('A completer via GBIF :', missing.length);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GBIF_MATCH = sci => `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}`;
const GBIF_IUCN = key => `https://api.gbif.org/v1/species/${key}/iucnRedListCategory`;

let ok = 0, notFound = 0, err = 0;
const changes = [];

for (let i = 0; i < missing.length; i++) {
  const sci = missing[i];
  // Format sci name : Genus species (seule la 1ere lettre du genus en majuscule).
  // Notre stockage local est en minuscules ("cyanopica cooki") pour uniformite.
  const parts = sci.split(' ');
  const scientificName = parts.length >= 2
    ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' ' + parts.slice(1).join(' ').toLowerCase()
    : sci;
  try {
    // Match GBIF -> usageKey
    const matchR = await fetch(GBIF_MATCH(scientificName));
    if (!matchR.ok) { err++; continue; }
    const match = await matchR.json();
    const key = match.usageKey || (match.acceptedUsageKey);
    if (!key) { notFound++; continue; }
    // IUCN category
    const iucnR = await fetch(GBIF_IUCN(key));
    if (!iucnR.ok) {
      if (iucnR.status === 404) notFound++;
      else err++;
      continue;
    }
    const iucn = await iucnR.json();
    const code = iucn.code;   // ex: "LC", "VU", "EN", ...
    if (!code) { notFound++; continue; }

    // Merge dans redlist
    const existing = redlist[sci] || {};
    redlist[sci] = { fr: existing.fr || 'NE', global: code };
    changes.push({ sci, code });
    ok++;

    if (i % 50 === 0 || i === missing.length - 1) {
      console.log(`  [${i+1}/${missing.length}] OK: ${ok}, NotFound: ${notFound}, Err: ${err} - ${sci} = ${code}`);
    }
  } catch (e) {
    err++;
    if (err <= 5) console.log('  ERR', sci, ':', e.message);
  }
  await sleep(100);   // courtoisie GBIF
}

console.log(`\nTermine. OK: ${ok}, NotFound: ${notFound}, Err: ${err}`);
console.log(`Redlist final : ${Object.keys(redlist).length} especes.`);

writeFileSync(REDLIST_PATH, JSON.stringify(redlist));
console.log(`Ecrit : ${REDLIST_PATH}`);

// Distribution des nouveaux codes
const dist = {};
for (const c of changes) dist[c.code] = (dist[c.code] || 0) + 1;
console.log('\nDistribution des nouveaux statuts :');
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k} : ${v}`);
}
