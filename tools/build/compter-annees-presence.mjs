#!/usr/bin/env node
/*
  compter-annees-presence.mjs - Compte, pour chaque espece et chaque pays, sur combien
  d'annees elle a ete observee entre 2019 et 2026.

  Lit les bar charts annuels produits par download-bar-charts-par-annee.mjs. Une espece
  presente dans le fichier d'une annee y a ete vue au moins une fois.

  C'est le seul critere qui distingue vraiment une rarete annuelle, qu'on peut aller
  chasser, d'un accidentel vu une fois. Le bar chart 2019-2026 ne le permet pas : il
  agrege sept ans dans 48 creneaux, donc un oiseau reste deux mois une seule annee y
  ressemble a une espece qui revient chaque annee.

  Sortie : data/generated/annees-presence.generated.js
  Format : { cc: { sciName: nombre d'annees } }

  Usage : node tools/build/compter-annees-presence.mjs [--dry]
*/
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const SRC = join(__dir, '..', 'ebird-barcharts-annees');
const OUT = join(ROOT, 'data', 'generated', 'annees-presence.generated.js');
const DRY = process.argv.includes('--dry');

if (!existsSync(SRC)) {
  console.error(`Dossier absent : ${SRC}`);
  console.error('Lancer d\'abord : EBIRD_COOKIE="..." node tools/build/download-bar-charts-par-annee.mjs');
  process.exit(1);
}

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

// Une espece compte pour l'annee si elle a au moins une valeur non nulle dans le fichier.
// Une ligne entierement a zero signifie qu'eBird la porte sur la liste du pays sans l'avoir
// rapportee cette annee-la : ce n'est pas une observation.
function especesVues(chemin) {
  const vues = new Set();
  for (const ln of readFileSync(chemin, 'utf8').split(/\r?\n/)) {
    if (!ln.includes('\t')) continue;
    const p = ln.split('\t');
    const nm = p[0].trim();
    const nums = p.slice(1, 49).map(Number).filter(x => !isNaN(x));
    if (!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
    if (/\bsp\.|\bou\b|\/|ybride/i.test(nm)) continue;
    if (!nums.some(v => v > 0)) continue;
    const sci = parNom[norm(nm.replace(/\s*\(.*?\)\s*/g, ' ').trim())] || parApp[norm(nm)];
    if (sci) vues.add(sci);
  }
  return vues;
}

const fichiers = readdirSync(SRC).filter(f => /^[A-Z]{2}-\d{4}\.txt$/.test(f));
if (!fichiers.length) { console.error('Aucun fichier annuel trouve.'); process.exit(1); }

const parPays = {};
for (const f of fichiers) {
  const [cc, an] = f.replace('.txt', '').split('-');
  const vues = especesVues(join(SRC, f));
  parPays[cc] = parPays[cc] || { annees: new Set(), compte: {} };
  parPays[cc].annees.add(an);
  for (const sci of vues) parPays[cc].compte[sci] = (parPays[cc].compte[sci] || 0) + 1;
}

const sortie = {};
console.log('\npays  annees  especes   repartition du nombre d annees de presence');
for (const [cc, o] of Object.entries(parPays)) {
  sortie[cc] = o.compte;
  const n = o.annees.size;
  const hist = {};
  for (const v of Object.values(o.compte)) hist[v] = (hist[v] || 0) + 1;
  const ligne = Array.from({ length: n }, (_, i) => `${i + 1}an:${hist[i + 1] || 0}`).join(' ');
  console.log('  ' + cc.padEnd(5) + String(n).padStart(4) + String(Object.keys(o.compte).length).padStart(9) + '   ' + ligne);
}

if (DRY) { console.log('\n--dry : fichier non ecrit.'); process.exit(0); }
writeFileSync(OUT,
  '// Genere par tools/build/compter-annees-presence.mjs. Ne pas editer a la main.\n' +
  '// Nombre d annees (2019-2026) ou chaque espece a ete observee, par pays.\n' +
  `export const ANNEES_PRESENCE = ${JSON.stringify(sortie)};\n`);
console.log(`\nEcrit : ${OUT}`);
