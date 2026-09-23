#!/usr/bin/env node
/*
  merge-freq-regions-fr.mjs - Met a jour data/countries/fr/freq_by_region.json depuis les
  bar charts 2019-2026, zone par zone, sans jamais changer la liste des zones.

  Pourquoi une fusion et pas un rebuild : ce fichier porte 109 zones, les 13 regions ET les
  96 departements, pour ~29 000 series. Un rebuild depuis build-rarity-multi-country.mjs le
  ramenerait aux seules zones qu'il sait produire et effacerait les autres — c'est arrive
  une fois, d'ou ce script dedie et le garde-fou pose dans le generateur.

  Le fichier etait sur la fenetre 2015-2026 alors que le national et les 15 autres pays sont
  sur 2019-2026, ce qui faisait divergier les cartes de rarete du tier national de la meme
  espece.

  Prerequis : les TSV 2019-2026 des zones a mettre a jour, obtenus par
  EBIRD_COOKIE="..." node tools/build/download-bar-charts-regional.mjs FR
  (/barchartData exige une session authentifiee, cf. l'en-tete de ce script-la).

  Une zone sans TSV est laissee telle quelle et signalee : mieux vaut une zone sur l'ancienne
  fenetre qu'une zone vide.

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
const zones = Object.keys(fichier);
const zonesAvant = zones.length;
const seriesAvant = Object.values(fichier).reduce((a, z) => a + Object.keys(z).length, 0);

let maj = 0, sansTsv = [], vides = [];
let deltaSeries = 0;
for (const z of zones) {
  const tsv = join(BAR_DIR, `ebird-barchart-${z}-2019-2026.txt`);
  if (!existsSync(tsv)) { sansTsv.push(z); continue; }
  const neuf = parse(tsv);
  const n = Object.keys(neuf).length;
  // Une zone qui ressort vide signale un TSV tronque : on ne remplace pas.
  if (n === 0) { vides.push(z); continue; }
  deltaSeries += n - Object.keys(fichier[z]).length;
  fichier[z] = neuf;
  maj++;
}

if (Object.keys(fichier).length !== zonesAvant) {
  console.error(`REFUS : le nombre de zones a change (${zonesAvant} -> ${Object.keys(fichier).length}).`);
  process.exit(1);
}

const seriesApres = Object.values(fichier).reduce((a, z) => a + Object.keys(z).length, 0);
console.log(`\n${maj}/${zonesAvant} zones mises a jour sur 2019-2026.`);
console.log(`series : ${seriesAvant} -> ${seriesApres} (${deltaSeries >= 0 ? '+' : ''}${deltaSeries})`);
if (sansTsv.length) console.log(`sans TSV 2019-2026, laissees telles quelles : ${sansTsv.length} (${sansTsv.slice(0, 8).join(', ')}${sansTsv.length > 8 ? '…' : ''})`);
if (vides.length) console.log(`TSV present mais aucune espece appariee, non remplacees : ${vides.join(', ')}`);

if (DRY) { console.log('\n--dry : fichier non modifie.'); process.exit(0); }
writeFileSync(CIBLE, JSON.stringify(fichier));
console.log('\ndata/countries/fr/freq_by_region.json mis a jour.');
