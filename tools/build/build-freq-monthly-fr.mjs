#!/usr/bin/env node
/*
  build-freq-monthly-fr.mjs - Reconstruit REAL_FREQ_MONTHLY (France) depuis le bar chart
  eBird FR 2019-2026, et l'injecte dans app.js.

  Pourquoi ce script existe : REAL_FREQ_MONTHLY n'avait plus ete regenere depuis le commit
  de decoupage index.html -> app.js. Il datait donc de build-rarity-ebird.mjs, qui lit
  FR_NAMES depuis index.html (fichier devenu obsolete, la table vit dans app.js) et
  appariait les anciens noms nord-americains de l'app contre un bar chart ecrit en
  nomenclature europeenne. Resultat : 46 especes avaient un tier de rarete sans aucun
  tableau mensuel, donc pas de courbe de saisonnalite et un score nul dans le selecteur
  de pays.

  L'appariement se fait ici comme pour les 15 autres pays : taxonomie eBird locale=fr_FR,
  qui parle exactement la langue des bar charts, avec FR_NAMES en second recours.

  On FUSIONNE au lieu de remplacer : les entrees existantes absentes du bar chart
  2019-2026 sont conservees. Ce sont d'anciennes cles de genre (bubulcus ibis,
  accipiter gentilis, charadrius dubius...) que du code peut encore interroger
  directement, sans passer par SCI_ALIAS.

  Ce script ne touche PAS REAL_RARITY : les tiers restent tels quels.

  Usage : node tools/build/build-freq-monthly-fr.mjs [--dry]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'app.js');
const TSV = join(ROOT, 'tools', 'ebird-barcharts-raw', 'ebird-barchart-FR-2019-2026.txt');
const DRY = process.argv.includes('--dry');

function extraire(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  let d = 0, debut = src.indexOf('{', i), j = debut;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) { j++; break; } }
  }
  return { litteral: src.substring(debut, j), debut, fin: j };
}

const norm = s => s.toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]/g, '');

let app = readFileSync(APP, 'utf8');
const cible = extraire(app, 'const REAL_FREQ_MONTHLY = ');
if (!cible) { console.error('REAL_FREQ_MONTHLY introuvable dans app.js.'); process.exit(1); }
const ancien = JSON.parse(cible.litteral);
const FR_NAMES = JSON.parse(extraire(app, 'const FR_NAMES = ').litteral);
const REAL_RARITY = JSON.parse(extraire(app, 'const REAL_RARITY = ').litteral);

console.log('Taxonomie eBird (locale=fr_FR)...');
const tax = await (await fetch(
  'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species',
  { headers: { 'X-eBirdApiToken': 'dbflh4atmsom' } }
)).json();
const parNom = {};
for (const t of tax) if (t.sciName && t.comName) parNom[norm(t.comName)] = t.sciName.toLowerCase();
const parNomApp = {};
for (const [sci, nom] of Object.entries(FR_NAMES)) if (!parNomApp[norm(nom)]) parNomApp[norm(nom)] = sci;

// 48 quinzaines -> 12 mois, en prenant le max des 4 quinzaines du mois.
const neuf = {};
let lignes = 0, apparies = 0;
for (const ln of readFileSync(TSV, 'utf8').split(/\r?\n/)) {
  if (!ln.includes('\t')) continue;
  const p = ln.split('\t');
  const nm = p[0].trim();
  const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
  if (!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
  lignes++;
  const k = norm(nm.replace(/\s*\(.*?\)\s*/g, ' ').trim());
  const sci = parNom[k] || parNomApp[k];
  if (!sci) continue;
  apparies++;
  const m12 = new Array(12).fill(0);
  for (let m = 0; m < 12; m++) {
    m12[m] = Math.max(nums[m*4] || 0, nums[m*4+1] || 0, nums[m*4+2] || 0, nums[m*4+3] || 0);
  }
  neuf[sci] = m12.map(v => +v.toFixed(5));
}

const fusion = { ...ancien, ...neuf };
const exploitable = (o, k) => Array.isArray(o[k]) && Math.max(...o[k]) > 0;
const tiers = Object.keys(REAL_RARITY);
const av = tiers.filter(k => exploitable(ancien, k)).length;
const ap = tiers.filter(k => exploitable(fusion, k)).length;

console.log(`\nBar chart FR : ${lignes} taxons, ${apparies} apparies.`);
console.log(`REAL_FREQ_MONTHLY : ${Object.keys(ancien).length} -> ${Object.keys(fusion).length} entrees.`);
console.log(`Tiers de rarete couverts par un tableau mensuel : ${av} -> ${ap} (sur ${tiers.length}).`);
const restants = tiers.filter(k => !exploitable(fusion, k));
console.log(`Restent sans tableau : ${restants.length} (aucune ligne dans le bar chart 2019-2026).`);

if (DRY) { console.log('\n--dry : app.js non modifie.'); process.exit(0); }
app = app.slice(0, cible.debut) + JSON.stringify(fusion) + app.slice(cible.fin);
writeFileSync(APP, app);
console.log('\napp.js mis a jour.');
