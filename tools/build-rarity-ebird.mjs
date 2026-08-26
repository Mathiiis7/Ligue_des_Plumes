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
const BARCHART = join(__dir, 'ebird-barchart-FR-2019-2026.txt');

// --- Seuils : pic de fréquence -> poids (Option 1 recalibré 2026-08-27) ---
// Ancien barème (avant 08/2026) : [0.35, 1], [0.20, 2], [0.10, 3], [0.05, 4], [0.02, 5],
//                                  [0.008, 6], [0.003, 7], [0.001, 8], reste 9.
// Nouveaux seuils élargissent les tiers 1-3 (progressions plus fluides pour débutants),
// resserrent tier 8-9 (dégonfle le tier 8 monstrueux de 223 espèces à ~100), et
// ajoutent un tier 10 "Fantôme" pour les vraies mégas (< 0.005% des sorties eBird).
const THRESHOLDS = [
  [0.25, 1], [0.15, 2], [0.08, 3], [0.04, 4],
  [0.02, 5], [0.007, 6], [0.0015, 7], [0.0003, 8],
  [0.00005, 9],
];
function weightFor(freq) {
  for (const [min, w] of THRESHOLDS) if (freq >= min) return w;
  return 10;   // tier 10 = Fantôme (<0.005% des sorties eBird FR)
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
  'Canard branchu': 'Canard carolin',            // Aix sponsa : app dit "branchu", eBird dit "carolin"
  'Flamant rouge': 'Flamant des Caraïbes',       // Phoenicopterus ruber : eBird utilise le nom "Caraïbes"
};

// --- FR_NAMES de l'app ---
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const FR = JSON.parse(html.match(/const FR_NAMES = (\{.*?\});/s)[1]);

// --- Parseur d'un fichier bar chart eBird -> { freqMax: {clé: pic annuel}, monthly: {clé: [12 pics]} } ---
function parseBarchart(path) {
  const freqMax = {}, monthly = {};
  for (const ln of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!ln.includes('\t')) continue;
    const p = ln.split('\t');
    const nm = p[0].trim();
    const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
    if (!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
    const clean = nm.replace(/\s*\(.*?\)\s*/g, ' ').trim(); // retire "(hybride...)" etc.
    const key = norm(clean);
    freqMax[key] = Math.max(...nums);
    // Bar chart eBird = 48 quinzaines (4 par mois × 12 mois). Pic mensuel = max des 4 quinzaines.
    const m12 = new Array(12).fill(0);
    for (let m = 0; m < 12; m++) {
      const start = m * 4;
      m12[m] = Math.max(nums[start]||0, nums[start+1]||0, nums[start+2]||0, nums[start+3]||0);
    }
    monthly[key] = m12;
  }
  return { freqMax, monthly };
}

// National : pour le calcul du poids de rareté (source de vérité).
const nat = parseBarchart(BARCHART);
const ebFreq = nat.freqMax;
const ebFreqMonthly = nat.monthly;

// Régional + départemental : cherche tous les bar charts eBird présents dans tools/,
// accepte les deux conventions de nommage :
//  - notre format renommé :  ebird-barchart-FR-PAC-2015-2026.txt
//  - nom eBird original :    ebird_FR-PAC__2015_2026_1_12_barchart.txt
//  - idem pour départements : FR-PAC-83, FR-OCC-34, etc.
// Clé de sortie = code region/département tel qu'extrait du nom de fichier.
import { readdirSync } from 'node:fs';
const regionalMonthly = {};   // code (FR-xx ou FR-xx-yy) -> {clé normalisée -> [12 pics]}
for (const fn of readdirSync(__dir)) {
  // extrait le code entre "barchart-" ou "ebird_"
  const m = fn.match(/^ebird[-_]?barchart-(FR-[A-Z]+(?:-[0-9A-Z]+)?)-\d{4}-\d{4}\.txt$/i)
         || fn.match(/^ebird_(FR-[A-Z]+(?:-[0-9A-Z]+)?)__\d{4}_\d{4}_\d+_\d+_barchart\.txt$/i);
  if (!m) continue;
  const code = m[1].toUpperCase();
  if (code === 'FR') continue;   // le national est déjà chargé pour REAL_RARITY
  regionalMonthly[code] = parseBarchart(join(__dir, fn)).monthly;
}

// --- Poids GBIF (repli) ---
const gbif = {};
if (existsSync(join(__dir, 'rarity-data.json'))) {
  for (const r of JSON.parse(readFileSync(join(__dir, 'rarity-data.json'), 'utf8')))
    gbif[r.sci] = r.weight;
}

// --- Calcul ---
const recs = [];
const monthly = {};   // sci -> [12 valeurs de fréquence mensuelle]
for (const sci in FR) {
  const name = FR[sci];
  const aliased = EBIRD_ALIAS[name];
  const key = norm(aliased || name);
  let freq = ebFreq[key];
  let source, weight;
  if (freq !== undefined) {
    source = aliased ? 'ebird-alias' : 'ebird';
    weight = weightFor(freq);
    if (ebFreqMonthly[key]) monthly[sci] = ebFreqMonthly[key];
  } else {
    source = 'gbif-fallback';
    weight = gbif[sci] != null ? gbif[sci] : 9; // absent partout -> exceptionnel
    freq = null;
  }
  recs.push({ sci, name, freq, source, weight });
}

recs.sort((a, b) => a.sci.localeCompare(b.sci));
writeFileSync(join(__dir, 'rarity-data-ebird.json'), JSON.stringify(recs, null, 2));

// Littéral REAL_RARITY : TOUS les tiers >= 1 (auparavant >= 2 avec fallback tier 1 dans le
// code, mais ça faisait bugger _isForeignOnly qui traitait les tier 1 comme "hors France").
const obj = {};
for (const r of recs) if (r.weight >= 1) obj[r.sci] = r.weight;
writeFileSync(join(__dir, 'real-rarity.generated.js'), 'const REAL_RARITY = ' + JSON.stringify(obj) + ';\n');

// Littéral REAL_FREQ_MONTHLY = { sci -> [12 pics mensuels 0..1] } - saisonnalité NATIONALE (fallback).
// On arrondit à 5 décimales pour réduire la taille (précision largement suffisante pour un filtre).
const mObj = {};
for (const sci in monthly) mObj[sci] = monthly[sci].map(v => +v.toFixed(5));
writeFileSync(join(__dir, 'real-freq-monthly.generated.js'), 'const REAL_FREQ_MONTHLY = ' + JSON.stringify(mObj) + ';\n');

// Littéral REAL_FREQ_MONTHLY_BY_REGION = { code_region -> { sci -> [12 pics mensuels 0..1] } }.
// Une espèce n'apparaît dans une région que si elle y a été observée au moins une fois.
// À l'exécution : on tente region → fallback national → fallback "actif" si aucune donnée.
const regObj = {};
for (const rc in regionalMonthly) {
  regObj[rc] = {};
  const nmap = regionalMonthly[rc];
  for (const sci in FR) {
    const name = FR[sci];
    const aliased = EBIRD_ALIAS[name];
    const key = norm(aliased || name);
    const m12 = nmap[key];
    if (m12) regObj[rc][sci] = m12.map(v => +v.toFixed(5));
  }
}
writeFileSync(join(__dir, 'real-freq-monthly-by-region.generated.js'),
  'const REAL_FREQ_MONTHLY_BY_REGION = ' + JSON.stringify(regObj) + ';\n');

// Récap régional
const regionSpeciesCount = Object.fromEntries(Object.entries(regObj).map(([k,v])=>[k, Object.keys(v).length]));
console.log('Régions parsées :', Object.keys(regObj).length, JSON.stringify(regionSpeciesCount));

// Récap
const dist = {}; for (let w = 1; w <= 9; w++) dist[w] = 0;
const bySrc = {};
for (const r of recs) { dist[r.weight]++; bySrc[r.source] = (bySrc[r.source] || 0) + 1; }
console.log('Espèces :', recs.length);
console.log('Sources :', JSON.stringify(bySrc));
console.log('Répartition par poids :', JSON.stringify(dist));
console.log('Dans REAL_RARITY (poids >= 2) :', Object.keys(obj).length);
console.log('Écrit : tools/rarity-data-ebird.json, tools/real-rarity.generated.js');
