#!/usr/bin/env node
/*
  build-habitats-avonet.mjs — Habitats par espece depuis Avonet (Tobias et al 2022,
  Ecology Letters, DOI 10.6084/m9.figshare.16586228).

  Source : tools/avonet.xlsx, sheet 'AVONET2_eBird' (10 661 species, taxonomie eBird)
  Colonnes utilisees : Species2 (sciName), Habitat (categorie unique).

  Categories Avonet (11) mappees vers IDs app + labels FR :
    forest     → 🌲 Forêt
    woodland   → 🌳 Bois / savane arborée
    shrubland  → 🌿 Arbustif / matorral
    grassland  → 🌾 Prairies / steppe
    wetland    → 🪺 Zones humides
    riverine   → 💧 Rivières / eau douce
    marine     → 🌊 Marin
    coastal    → 🏖️ Littoral / côte
    rock       → 🪨 Rocher / falaises
    desert     → 🏜️ Désert
    humanmod   → 🏙️ Modifié par l'homme (urbain, agricole)

  Avonet donne UNE SEULE catégorie primaire par espèce (vs notre ancien mapping qui
  en avait 1-3). Plus fiable, moins de bruit dans le filtre.

  Sortie : re-injecte HABITATS + HABITAT_CATS + HABITAT_LABELS + HABITAT_TO_SCIS
  dans index.html.

  Usage : node tools/build-habitats-avonet.mjs
*/
import XLSX from 'xlsx';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const XLSX_PATH = join(__dir, 'avonet.xlsx');
const HTML_PATH = join(ROOT, 'index.html');

// Mapping Avonet English → id kebab local. Un id "humanmod" pour eviter les espaces.
const AVONET_TO_ID = {
  'Forest': 'forest',
  'Woodland': 'woodland',
  'Shrubland': 'shrubland',
  'Grassland': 'grassland',
  'Wetland': 'wetland',
  'Riverine': 'riverine',
  'Marine': 'marine',
  'Coastal': 'coastal',
  'Rock': 'rock',
  'Desert': 'desert',
  'Human Modified': 'humanmod',
};
const CAT_ORDER = ['forest','woodland','shrubland','grassland','wetland','riverine','marine','coastal','rock','desert','humanmod'];
const LABELS_FR = {
  forest:    '🌲 Forêt',
  woodland:  '🌳 Bois / savane arborée',
  shrubland: '🌿 Arbustif / matorral',
  grassland: '🌾 Prairies / steppe',
  wetland:   '🪺 Zones humides',
  riverine:  '💧 Rivières / eau douce',
  marine:    '🌊 Marin (pélagique)',
  coastal:   '🏖️ Littoral / côte',
  rock:      '🪨 Rocher / falaises',
  desert:    '🏜️ Désert',
  humanmod:  '🏙️ Modifié par l\'homme',
};

console.log('[1] Lecture Avonet xlsx (AVONET2_eBird)...');
const wb = XLSX.readFile(XLSX_PATH);
const ws = wb.Sheets['AVONET2_eBird'];
if (!ws) { console.error('Sheet AVONET2_eBird introuvable'); process.exit(1); }
const rows = XLSX.utils.sheet_to_json(ws);
console.log(`    ${rows.length} lignes.`);

console.log('\n[2] Construction du dict HABITATS (sci -> [catId])...');
const HABITATS = {};
const skipped = { na: 0, unknown: 0 };
for (const r of rows) {
  const sci = String(r.Species2 || '').trim().toLowerCase();
  const hab = String(r.Habitat || '').trim();
  if (!sci) continue;
  if (hab === 'NA' || !hab) { skipped.na++; continue; }
  const id = AVONET_TO_ID[hab];
  if (!id) { skipped.unknown++; console.warn('  Habitat inconnu :', hab); continue; }
  HABITATS[sci] = [id];   // 1 cat par espece (garde le format Array pour compat)
}
console.log(`    HABITATS : ${Object.keys(HABITATS).length} especes couvertes.`);
console.log(`    Skipped NA : ${skipped.na}, unknown : ${skipped.unknown}`);

// Distribution
const dist = {};
for (const cats of Object.values(HABITATS)) for (const c of cats) dist[c] = (dist[c] || 0) + 1;
console.log('    Distribution :');
for (const c of CAT_ORDER) console.log(`      ${c.padEnd(10)}: ${dist[c] || 0}`);

console.log('\n[3] Re-injection dans index.html...');
let html = readFileSync(HTML_PATH, 'utf8');

// Helper : remplace un const literal dans le HTML par une nouvelle valeur.
function replaceConstLiteral(html, name, newLiteral) {
  const startMarker = `const ${name} =`;
  const start = html.indexOf(startMarker);
  if (start < 0) throw new Error(`${name} introuvable`);
  const openIdx = html.indexOf('{', start);
  if (openIdx < 0 || openIdx > start + 60) {
    // Peut-etre un array literal
    const brIdx = html.indexOf('[', start);
    if (brIdx < 0 || brIdx > start + 60) throw new Error(`${name} : pas de { ni [`);
    // Trouve la fin du tableau
    let depth = 0, inStr = false, esc = false, ei = -1;
    for (let i = brIdx; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { ei = i; break; } }
    }
    const si = html.indexOf(';', ei);
    return html.slice(0, start) + `const ${name} = ${newLiteral};` + html.slice(si + 1);
  }
  // Object literal
  let depth = 0, inStr = false, esc = false, ei = -1;
  for (let i = openIdx; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { ei = i; break; } }
  }
  const si = html.indexOf(';', ei);
  return html.slice(0, start) + `const ${name} = ${newLiteral};` + html.slice(si + 1);
}

const before = html.length;
html = replaceConstLiteral(html, 'HABITATS', JSON.stringify(HABITATS));
html = replaceConstLiteral(html, 'HABITAT_CATS', JSON.stringify(CAT_ORDER));
html = replaceConstLiteral(html, 'HABITAT_LABELS', JSON.stringify(LABELS_FR));

writeFileSync(HTML_PATH, html);
console.log(`    index.html : ${before} -> ${html.length} (${html.length - before > 0 ? '+' : ''}${html.length - before} bytes)`);
console.log('\n[OK] Termine.');
