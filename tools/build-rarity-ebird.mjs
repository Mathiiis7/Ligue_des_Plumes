#!/usr/bin/env node
/*
  build-rarity-ebird.mjs — Barème de "rareté réelle" basé sur la FRÉQUENCE eBird.

  PRINCIPE
  --------
  On repart du "bar chart" eBird France (part des listes qui mentionnent l'espèce,
  par demi-mois, sur 2015-2026). C'est une mesure NORMALISÉE PAR L'EFFORT : combien
  de fois, sur 100 sorties, un birder note l'espèce. On prend le PIC annuel (max des
  48 valeurs) = présence maximale = meilleur proxy du "taux de rencontre réel".

  Plus le pic de fréquence est bas, plus l'espèce est rare -> poids (1 à 9) élevé.

  BARÈME (seuils fixes sur le pic de fréquence) — SOURCE DE VÉRITÉ DU POIDS
  ------------------------------------------------------------------------
     freq >= 0.35  -> 1  Très commun
     freq >= 0.20  -> 2  Commun
     freq >= 0.10  -> 3  Assez commun
     freq >= 0.05  -> 4  Peu commun
     freq >= 0.02  -> 5  Localisé
     freq >= 0.008 -> 6  Assez rare
     freq >= 0.003 -> 7  Rare
     freq >= 0.001 -> 8  Très rare
     freq <  0.001 -> 9  Exceptionnel

  APPARIEMENT DES NOMS
  --------------------
  eBird FR ≠ noms FR de l'app pour ~16 espèces (renommages : Orite=Mésange à longue
  queue, Gravelot=Pluvier, Chouette de Tengmalm=Nyctale...). Table EBIRD_ALIAS ci-dessous.
  Reste : normalisation (minuscules, sans accents/ligatures/ponctuation).

  REPLI
  -----
  Espèces absentes du bar chart (vagrants/exotiques rarissimes) -> on reprend le
  poids GBIF de tools/rarity-data.json (déjà 8-9 pour ces espèces). Exotiques forcées
  à 1 à l'affichage (liste EXOTIC de index.html), inutile de les traiter ici.

  SORTIES
  -------
  - tools/rarity-data-ebird.json     : audit {sci, name, freq, source, weight}
  - tools/real-rarity.generated.js   : littéral `const REAL_RARITY = {...}` (poids >= 2)

  USAGE : node tools/build-rarity-ebird.mjs
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const BARCHART = join(__dir, 'ebird-barchart-FR-2015-2026.txt');

// --- Seuils : pic de fréquence -> poids (source de vérité) ---
const THRESHOLDS = [
  [0.35, 1], [0.20, 2], [0.10, 3], [0.05, 4],
  [0.02, 5], [0.008, 6], [0.003, 7], [0.001, 8],
];
function weightFor(freq) {
  for (const [min, w] of THRESHOLDS) if (freq >= min) return w;
  return 9;
}

const norm = s => s.toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/g, '');

// Renommages eBird : nom FR de l'app -> nom FR utilisé par eBird dans le bar chart.
const EBIRD_ALIAS = {
  'Mésange à longue queue': 'Orite à longue queue',
  'Pluvier grand-gravelot': 'Grand Gravelot',
  'Pluvier à collier interrompu': 'Gravelot à collier interrompu',
  'Pluvier semipalmé': 'Gravelot semipalmé',
  'Pluvier kildir': 'Gravelot kildir',
  'Pluvier de Leschenault': 'Gravelot de Leschenault',
  'Pluvier asiatique': 'Gravelot asiatique',
  'Pluvier guignard': "Guignard d'Eurasie",
  'Nyctale de Tengmalm': 'Chouette de Tengmalm',
  'Hibou grand-duc': "Grand-duc d'Europe",
  'Maubèche des champs': 'Bartramie des champs',
  'Monticole merle-de-roche': 'Monticole de roche',
  'Monticole merle-bleu': 'Monticole bleu',
  'Rossignol à flancs roux': 'Robin à flancs roux',
  'Viréo aux yeux rouges': 'Viréo à œil rouge',
  'Plongeon huard': 'Plongeon imbrin',
};

// --- FR_NAMES de l'app ---
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const FR = JSON.parse(html.match(/const FR_NAMES = (\{.*?\});/s)[1]);

// --- Pic de fréquence eBird par nom normalisé ---
const ebFreq = {};
for (const ln of readFileSync(BARCHART, 'utf8').split(/\r?\n/)) {
  if (!ln.includes('\t')) continue;
  const p = ln.split('\t');
  const nm = p[0].trim();
  const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
  if (!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
  const clean = nm.replace(/\s*\(.*?\)\s*/g, ' ').trim(); // retire "(hybride...)" etc.
  ebFreq[norm(clean)] = Math.max(...nums);
}

// --- Poids GBIF (repli) ---
const gbif = {};
if (existsSync(join(__dir, 'rarity-data.json'))) {
  for (const r of JSON.parse(readFileSync(join(__dir, 'rarity-data.json'), 'utf8')))
    gbif[r.sci] = r.weight;
}

// --- Calcul ---
const recs = [];
for (const sci in FR) {
  const name = FR[sci];
  const aliased = EBIRD_ALIAS[name];
  let freq = ebFreq[norm(aliased || name)];
  let source, weight;
  if (freq !== undefined) {
    source = aliased ? 'ebird-alias' : 'ebird';
    weight = weightFor(freq);
  } else {
    source = 'gbif-fallback';
    weight = gbif[sci] != null ? gbif[sci] : 9; // absent partout -> exceptionnel
    freq = null;
  }
  recs.push({ sci, name, freq, source, weight });
}

recs.sort((a, b) => a.sci.localeCompare(b.sci));
writeFileSync(join(__dir, 'rarity-data-ebird.json'), JSON.stringify(recs, null, 2));

// Littéral REAL_RARITY (poids >= 2 ; poids 1 = défaut à l'exécution)
const obj = {};
for (const r of recs) if (r.weight >= 2) obj[r.sci] = r.weight;
writeFileSync(join(__dir, 'real-rarity.generated.js'), 'const REAL_RARITY = ' + JSON.stringify(obj) + ';\n');

// Récap
const dist = {}; for (let w = 1; w <= 9; w++) dist[w] = 0;
const bySrc = {};
for (const r of recs) { dist[r.weight]++; bySrc[r.source] = (bySrc[r.source] || 0) + 1; }
console.log('Espèces :', recs.length);
console.log('Sources :', JSON.stringify(bySrc));
console.log('Répartition par poids :', JSON.stringify(dist));
console.log('Dans REAL_RARITY (poids >= 2) :', Object.keys(obj).length);
console.log('Écrit : tools/rarity-data-ebird.json, tools/real-rarity.generated.js');
