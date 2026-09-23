#!/usr/bin/env node
/*
  merge-freq-regions-fr.mjs - Met a jour les 13 regions francaises dans
  data/countries/fr/freq_by_region.json depuis les bar charts 2019-2026,
  SANS toucher aux 96 departements du meme fichier.

  Pourquoi une fusion et pas un rebuild : ce fichier porte 109 zones, les 13 regions ET les
  96 departements, pour 29 298 series. Seuls les bar charts des 13 regions existent en local
  (les departements viennent d'une source aujourd'hui perdue). Un rebuild complet le
  ramenerait a 13 zones et effacerait toutes les cartes departementales — c'est arrive une
  fois, d'ou ce script dedie et le garde-fou pose dans build-rarity-multi-country.mjs.

  Prerequis : les 13 fichiers ebird-barchart-FR-XXX-2019-2026.txt, obtenus par
  EBIRD_COOKIE="..." node tools/build/download-bar-charts-regional.mjs FR

  Usage : node tools/build/merge-freq-regions-fr.mjs [--dry]
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const BAR_DIR = join(ROOT, 'tools', 'ebird-barcharts-raw');
const CIBLE = join(ROOT, 'data', 'countries', 'fr', 'freq_by_region.json');
const DRY = process.argv.includes('--dry');

const REGIONS = ['FR-ARA','FR-BFC','FR-BRE','FR-COR','FR-CVL','FR-GES','FR-HDF',
                 'FR-IDF','FR-NAQ','FR-NOR','FR-OCC','FR-PAC','FR-PDL'];

const norm = s => s.toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]/g, '');

function extraire(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  let d = 0, debut = src.indexOf('{', i), j = debut;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) { j++; break; } }
  }
  return JSON.parse(src.substring(debut, j));
}

const manquants = REGIONS.filter(r => !existsSync(join(BAR_DIR, `ebird-barchart-${r}-2019-2026.txt`)));
if (manquants.length) {
  console.error(`${manquants.length} bar charts regionaux 2019-2026 absents : ${manquants.join(', ')}`);
  console.error('Lancer d\'abord : EBIRD_COOKIE="..." node tools/build/download-bar-charts-regional.mjs FR');
  process.exit(1);
}

console.log('Taxonomie eBird (locale=fr_FR)...');
const tax = await (await fetch(
  'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species',
  { headers: { 'X-eBirdApiToken': 'dbflh4atmsom' } }
)).json();
const parNom = {};
for (const t of tax) if (t.sciName && t.comName) parNom[norm(t.comName)] = t.sciName.toLowerCase();
const FR_NAMES = extraire(readFileSync(join(ROOT, 'app.js'), 'utf8'), 'const FR_NAMES = ');
const parApp = {};
for (const [sci, nom] of Object.entries(FR_NAMES)) if (!parApp[norm(nom)]) parApp[norm(nom)] = sci;

// 48 quinzaines -> 12 mois, max des 4 quinzaines du mois (meme conversion que partout).
function parse(chemin) {
  const out = {};
  for (const ln of readFileSync(chemin, 'utf8').split(/\r?\n/)) {
    if (!ln.includes('\t')) continue;
    const p = ln.split('\t');
    const nm = p[0].trim();
    const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
    if (!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
    const k = norm(nm.replace(/\s*\(.*?\)\s*/g, ' ').trim());
    const sci = parNom[k] || parApp[k];
    if (!sci) continue;
    const m12 = new Array(12).fill(0);
    for (let m = 0; m < 12; m++) {
      m12[m] = Math.max(nums[m*4] || 0, nums[m*4+1] || 0, nums[m*4+2] || 0, nums[m*4+3] || 0);
    }
    out[sci] = m12.map(v => +v.toFixed(5));
  }
  return out;
}

const fichier = JSON.parse(readFileSync(CIBLE, 'utf8'));
const zonesAvant = Object.keys(fichier).length;
const deps = Object.keys(fichier).filter(z => !REGIONS.includes(z));

console.log('\nregion    avant -> apres (especes)');
for (const r of REGIONS) {
  const neuf = parse(join(BAR_DIR, `ebird-barchart-${r}-2019-2026.txt`));
  const avant = fichier[r] ? Object.keys(fichier[r]).length : 0;
  console.log(`  ${r.padEnd(9)} ${String(avant).padStart(5)} -> ${String(Object.keys(neuf).length).padStart(5)}`);
  fichier[r] = neuf;
}

const zonesApres = Object.keys(fichier).length;
if (zonesApres !== zonesAvant || deps.length !== zonesAvant - REGIONS.length) {
  console.error(`\nREFUS : le nombre de zones a change (${zonesAvant} -> ${zonesApres}).`);
  process.exit(1);
}
const series = Object.values(fichier).reduce((a, z) => a + Object.keys(z).length, 0);
console.log(`\n${zonesApres} zones conservees (13 regions + ${deps.length} departements), ${series} series.`);

if (DRY) { console.log('\n--dry : fichier non modifie.'); process.exit(0); }
writeFileSync(CIBLE, JSON.stringify(fichier));
console.log('data/countries/fr/freq_by_region.json mis a jour.');
