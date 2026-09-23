#!/usr/bin/env node
/*
  inject-exotic-by-dep-fr.mjs - Injecte EXOTIC_STATUS_BY_DEP_FR dans app.js depuis
  tools/build/exotic-by-dep-fr.generated.js.

  Cette table etait jusqu'ici reportee a la main, ce qui l'avait laissee derriver : elle
  portait encore des tags issus d'observations anterieures a 2019, alors que les bar charts
  et tous les autres scrapes sont alignes sur 2019-2026.

  Usage : node tools/build/inject-exotic-by-dep-fr.mjs [--dry]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'app.js');
const GEN = join(ROOT, 'tools', 'build', 'exotic-by-dep-fr.generated.js');
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

let app = readFileSync(APP, 'utf8');
const cible = extraire(app, 'EXOTIC_STATUS_BY_DEP_FR = ');
if (!cible) { console.error('EXOTIC_STATUS_BY_DEP_FR introuvable dans app.js.'); process.exit(1); }
const source = extraire(readFileSync(GEN, 'utf8'), 'EXOTIC_STATUS_BY_DEP_FR = ');
if (!source) { console.error('Table absente du fichier genere.'); process.exit(1); }

const ancien = JSON.parse(cible.litteral);
const neuf = JSON.parse(source.litteral);
const tags = o => Object.values(o).reduce((a, m) => a + Object.keys(m).length, 0);

console.log(`departements : ${Object.keys(ancien).length} -> ${Object.keys(neuf).length}`);
console.log(`tags exotiques : ${tags(ancien)} -> ${tags(neuf)}`);

// Ce qui disparait : des tags poses sur des observations d'avant la fenetre 2019-2026.
let retires = 0, ajoutes = 0;
for (const [dep, m] of Object.entries(ancien))
  for (const sci of Object.keys(m)) if (!(neuf[dep] && neuf[dep][sci])) retires++;
for (const [dep, m] of Object.entries(neuf))
  for (const sci of Object.keys(m)) if (!(ancien[dep] && ancien[dep][sci])) ajoutes++;
console.log(`  ${retires} tags retires, ${ajoutes} ajoutes.`);

if (DRY) { console.log('\n--dry : app.js non modifie.'); process.exit(0); }
app = app.slice(0, cible.debut) + JSON.stringify(neuf) + app.slice(cible.fin);
writeFileSync(APP, app);
console.log('\napp.js mis a jour.');
