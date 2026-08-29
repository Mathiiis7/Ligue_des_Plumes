#!/usr/bin/env node
/*
  inject-abundance-st.mjs — remplace le litteral REAL_ABUNDANCE_ST_FR dans index.html
  par celui produit par tools/real-abundance-st.generated.js.

  Le generated.js est ecrit par tools/ebirdst/build-abundance-by-country.R (Rscript).
  On extrait la ligne "export const REAL_ABUNDANCE_ST_FR = {...};" puis on remplace
  dans index.html la premiere occurrence de "const REAL_ABUNDANCE_ST_FR = ...;".

  Usage : node tools/inject-abundance-st.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const GEN = join(__dir, 'real-abundance-st.generated.js');
const HTML = join(ROOT, 'index.html');

const gen = readFileSync(GEN, 'utf8');
// Match : "export const REAL_ABUNDANCE_ST_FR = <literal JSON>;"
const m = gen.match(/export\s+const\s+REAL_ABUNDANCE_ST_FR\s*=\s*(\{.*\})\s*;\s*$/s);
if (!m) { console.error('Litteral REAL_ABUNDANCE_ST_FR introuvable dans', GEN); process.exit(1); }
const literal = m[1];

const html = readFileSync(HTML, 'utf8');
// Match la declaration existante (une ligne). On cherche "const REAL_ABUNDANCE_ST_FR = {...};"
// avec {...} eventuellement enorme. Non-greedy sur la premiere occurrence.
const before = html;
// Recherche la balise ouvrante et compte les accolades pour trouver la fin (JSON valide).
const startIdx = html.indexOf('const REAL_ABUNDANCE_ST_FR = ');
if (startIdx < 0) { console.error('Declaration REAL_ABUNDANCE_ST_FR introuvable dans index.html'); process.exit(1); }
const braceStart = html.indexOf('{', startIdx);
if (braceStart < 0) { console.error('Accolade ouvrante manquante apres declaration'); process.exit(1); }
// Parcours pour trouver l'accolade fermante correspondante (naive : compte { et }, ignore
// les strings JSON). JSON produit par toJSON() : pas d'accolades dans les strings de sci name
// puisque ce sont juste "genus species" ; donc compter suffit.
let depth = 0, endIdx = -1, inStr = false, esc = false;
for (let i = braceStart; i < html.length; i++) {
  const c = html[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (c === '"') { inStr = !inStr; continue; }
  if (inStr) continue;
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
}
if (endIdx < 0) { console.error('Accolade fermante non trouvee'); process.exit(1); }
// Le ; final attendu apres endIdx
const semiIdx = html.indexOf(';', endIdx);

const newHtml = html.slice(0, startIdx) + 'const REAL_ABUNDANCE_ST_FR = ' + literal + ';' + html.slice(semiIdx + 1);
const sizeDiff = newHtml.length - html.length;
writeFileSync(HTML, newHtml);
console.log(`OK. Taille du JSON injecte : ${literal.length} chars.`);
console.log(`index.html : ${html.length} -> ${newHtml.length} (${sizeDiff >= 0 ? '+' : ''}${sizeDiff} bytes).`);
console.log(`Especes contenues : ${(literal.match(/":\{/g) || []).length}`);
