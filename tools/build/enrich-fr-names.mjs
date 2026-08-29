#!/usr/bin/env node
/*
  enrich-fr-names.mjs — Enrichit FR_NAMES avec la eBird taxonomy complete
  en francais. Fetch UNE fois via /v2/ref/taxonomy/ebird?locale=fr&cat=species.

  Comportement :
    - Ajoute tous les sci name manquants dans FR_NAMES (11k species mondiales)
    - Conserve les noms existants dans FR_NAMES (override manuels prioritaires,
      certains sont custom "Canard branchu" alors qu'eBird dit "Canard carolin")
    - Signale les changements a valider :
      * Especes dans FR_NAMES mais absentes de la nouvelle taxonomy (peut-etre
        renommees/splittees, a verifier)
      * Especes ou notre nom diverge du nom eBird (potentiel alias a garder ou
        drift a corriger)

  Sortie : re-inject FR_NAMES dans index.html + rapport console.
  Usage : node tools/enrich-fr-names.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const HTML_PATH = join(ROOT, 'index.html');
const EBIRD_KEY = 'dbflh4atmsom';

console.log('[1] Extract FR_NAMES actuel de index.html...');
const html = readFileSync(HTML_PATH, 'utf8');
const frMatch = html.match(/const FR_NAMES = (\{.*?\});/s);
if (!frMatch) throw new Error('FR_NAMES introuvable dans index.html');
const currentFR = JSON.parse(frMatch[1]);
console.log(`    Actuel : ${Object.keys(currentFR).length} especes.`);

console.log('\n[2] Fetch eBird taxonomy (locale=fr, ~2 MB)...');
const tax = await (await fetch(
  'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species',
  { headers: { 'X-eBirdApiToken': EBIRD_KEY } }
)).json();
console.log(`    Recu : ${tax.length} especes.`);

// Map sci lowercase -> comName fr
const ebNameBy = {};
for (const t of tax) {
  if (t.sciName && t.comName) {
    ebNameBy[t.sciName.toLowerCase()] = t.comName;
  }
}

console.log('\n[3] Merge des noms...');
const merged = { ...currentFR };
let added = 0;
let kept = 0;
const diverged = [];   // noms differents entre notre app et eBird
const missing = [];    // noms dans FR_NAMES mais absents d'eBird

// Ajouts + verification divergences
for (const [sci, ebName] of Object.entries(ebNameBy)) {
  if (currentFR[sci]) {
    if (currentFR[sci] !== ebName) {
      diverged.push({ sci, ours: currentFR[sci], ebird: ebName });
    }
    kept++;
  } else {
    merged[sci] = ebName;
    added++;
  }
}

// Especes dans FR_NAMES mais absentes de la nouvelle taxonomy
for (const sci in currentFR) {
  if (!ebNameBy[sci]) missing.push({ sci, ours: currentFR[sci] });
}

console.log(`    Ajoutees : ${added}`);
console.log(`    Deja presentes (nom conserve) : ${kept}`);
console.log(`    Divergentes (nom app != eBird) : ${diverged.length}`);
console.log(`    Absentes de la nouvelle taxonomy : ${missing.length}`);

if (diverged.length > 0) {
  console.log('\n=== DIVERGENCES (les noms de l\'app sont conserves - override manuel) ===');
  for (const d of diverged.slice(0, 20)) {
    console.log(`  ${d.sci} : app="${d.ours}" | eBird="${d.ebird}"`);
  }
  if (diverged.length > 20) console.log(`  ... et ${diverged.length - 20} autres.`);
}

if (missing.length > 0) {
  console.log('\n=== ABSENTES DE LA TAXONOMY EBIRD (a verifier, peut-etre renommees) ===');
  for (const m of missing.slice(0, 30)) {
    console.log(`  ${m.sci} = "${m.ours}"`);
  }
  if (missing.length > 30) console.log(`  ... et ${missing.length - 30} autres.`);
}

console.log(`\n[4] Total FR_NAMES apres merge : ${Object.keys(merged).length} especes.`);

// Trie par sci (canonique) pour stabilite du diff git
const sorted = {};
for (const sci of Object.keys(merged).sort()) sorted[sci] = merged[sci];

console.log('\n[5] Re-injection dans index.html...');
const literal = JSON.stringify(sorted);
const start = html.indexOf('const FR_NAMES = ');
const bs = html.indexOf('{', start);
let depth = 0, inStr = false, esc = false, ei = -1;
for (let i = bs; i < html.length; i++) {
  const c = html[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (c === '"') { inStr = !inStr; continue; }
  if (inStr) continue;
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { ei = i; break; } }
}
const si = html.indexOf(';', ei);
const before = html.length;
const newHtml = html.slice(0, start) + 'const FR_NAMES = ' + literal + ';' + html.slice(si + 1);
writeFileSync(HTML_PATH, newHtml);
console.log(`    OK. index.html : ${before} -> ${newHtml.length} (+${newHtml.length - before} bytes)`);
