#!/usr/bin/env node
/*
  align-fr-names.mjs - Aligne FR_NAMES sur la nomenclature francaise europeenne d'eBird
  (API locale=fr_FR), qui est celle qu'affichent les bar charts.

  Pourquoi : l'app melangeait deux traditions de nommage. locale=fr renvoie la nomenclature
  nord-americaine (Plongeon huard, Pluvier grand-gravelot, Nyctale de Tengmalm), locale=fr_FR
  la nomenclature europeenne (Plongeon imbrin, Grand Gravelot, Chouette de Tengmalm). Les bar
  charts eBird, source unique de la rarete depuis le 2026-09-23, parlent europeen. Afficher
  des noms americains a cote de donnees etiquetees en europeen n'avait pas de sens.

  Deux corrections sont appliquees au nom renvoye par l'API :
    - l'apostrophe typographique U+2019 devient une apostrophe droite. FR_NAMES n'utilise que
      la droite (582 noms, zero courbe) : introduire la courbe rendrait le nom intapable dans
      la recherche.
    - une ligature oe/OE perdue par eBird est restauree. "Heron garde-boeufs" n'est pas un
      autre nom que "Heron garde-boeufs" avec ligature, c'est le meme nom mal encode dans les
      donnees eBird. On ne degrade pas la typographie francaise pour suivre un export.

  Les anciens noms sont conserves dans FR_NAMES_ANCIENS pour rester trouvables par la
  recherche : quelqu'un qui tape "Nyctale" ou "Petit Garrot" doit encore tomber sur l'espece.

  Usage : node tools/build/align-fr-names.mjs [--dry]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');
const DRY = process.argv.includes('--dry');

// Extrait `<decl> = {...};` en equilibrant les accolades : les valeurs contiennent des
// accolades imbriquees, un regex non greedy ne suffit pas.
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

// Restaure une ligature que l'export eBird a aplatie, et normalise l'apostrophe.
function corriger(apiNom, ancien) {
  let n = apiNom.replace(/\u2019/g, "'");
  const aplati = s => s.replace(/œ/g, 'oe').replace(/Œ/g, 'Oe');
  if (ancien && aplati(ancien) === aplati(n) && ancien !== n) return ancien;
  return n;
}

let app = readFileSync(APP, 'utf8');
const cible = extraire(app, 'const FR_NAMES = ');
if (!cible) { console.error('FR_NAMES introuvable dans app.js.'); process.exit(1); }
const noms = JSON.parse(cible.litteral);

console.log('Recuperation de la taxonomie eBird (locale=fr_FR)...');
const tax = await (await fetch(
  'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species',
  { headers: { 'X-eBirdApiToken': 'dbflh4atmsom' } }
)).json();
const parSci = {};
for (const t of tax) if (t.sciName && t.comName) parSci[t.sciName.toLowerCase()] = t.comName;
console.log(`  ${Object.keys(parSci).length} taxons.\n`);

const anciens = {};
const changes = [];
let horsApi = 0, ligature = 0;
for (const [sci, ancien] of Object.entries(noms)) {
  const api = parSci[sci];
  if (!api) { horsApi++; continue; }
  const neuf = corriger(api, ancien);
  if (neuf === ancien) { if (api !== ancien) ligature++; continue; }
  noms[sci] = neuf;
  anciens[sci] = ancien;
  changes.push([ancien, neuf]);
}

changes.sort((a, b) => a[0].localeCompare(b[0], 'fr'));
for (const [a, b] of changes) console.log(`  ${a.padEnd(34)} -> ${b}`);
console.log(`\n${changes.length} noms alignes.`);
console.log(`${ligature} ligatures oe preservees contre l'export eBird.`);
console.log(`${horsApi} entrees absentes de l'API (taxons anciens, alias) laissees intactes.`);

if (DRY) { console.log('\n--dry : app.js non modifie.'); process.exit(0); }

// Remplace FR_NAMES, puis pose ou remplace FR_NAMES_ANCIENS juste apres.
app = app.slice(0, cible.debut) + JSON.stringify(noms) + app.slice(cible.fin);

const blocAnciens =
  `\n// Noms francais d'avant l'alignement sur la nomenclature europeenne (2026-09-23), gardes\n` +
  `// uniquement pour que la recherche continue de les trouver : taper "Nyctale de Tengmalm"\n` +
  `// ou "Petit Garrot" doit toujours mener a l'espece. Genere par tools/build/align-fr-names.mjs.\n` +
  `const FR_NAMES_ANCIENS = ${JSON.stringify(anciens)};\n`;

const dejaLa = extraire(app, 'const FR_NAMES_ANCIENS = ');
if (dejaLa) {
  app = app.slice(0, dejaLa.debut) + JSON.stringify(anciens) + app.slice(dejaLa.fin);
} else {
  const fin = app.indexOf(';', app.indexOf('const FR_NAMES = ') + 10);
  const apresFRNames = app.indexOf('\n', fin) + 1;
  app = app.slice(0, apresFRNames) + blocAnciens + app.slice(apresFRNames);
}

writeFileSync(APP, app);
console.log(`\napp.js mis a jour (${Object.keys(anciens).length} anciens noms conserves pour la recherche).`);
