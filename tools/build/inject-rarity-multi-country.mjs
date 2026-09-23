#!/usr/bin/env node
/*
  inject-rarity-multi-country.mjs - Injecte dans app.js les tables produites par
  build-rarity-multi-country.mjs : REAL_RARITY_<CC>_EBIRD et REAL_FREQ_MONTHLY_<CC>.

  Ces tables etaient jusqu'ici posees a la main, ce qui rendait un rebuild penible et
  risque. Ce script rend l'operation reproductible et verifiable.

  Usage : node tools/build/inject-rarity-multi-country.mjs [CC,CC...]
    sans argument : les 14 pays multi-country
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const APP = join(ROOT, 'app.js');

const TOUS = ['ES','IT','GB','PT','CH','NO','GR','IS','LK','NA','AU','NZ','US','CA'];
const arg = process.argv[2];
const PAYS = arg ? arg.split(',').map(s => s.trim().toUpperCase()) : TOUS;

// Extrait `<NOM> = {...};` en equilibrant les accolades (les valeurs contiennent des
// accolades imbriquees, un regex non greedy ne suffit pas).
function extraire(src, nom) {
  const i = src.indexOf(nom + ' = ');
  if (i < 0) return null;
  let d = 0, debut = src.indexOf('{', i), j = debut;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) { j++; break; } }
  }
  return { litteral: src.substring(debut, j), debut, fin: j };
}

let app = readFileSync(APP, 'utf8');
let total = 0;

for (const cc of PAYS) {
  const f = join(ROOT, 'data', 'generated', `real-rarity-${cc.toLowerCase()}-ebird.generated.js`);
  if (!existsSync(f)) { console.warn(`${cc} : ${f} absent, skip.`); continue; }
  const gen = readFileSync(f, 'utf8');

  for (const nom of [`REAL_RARITY_${cc}_EBIRD`, `REAL_FREQ_MONTHLY_${cc}`]) {
    const source = extraire(gen, nom);
    if (!source) { console.warn(`  ${nom} : introuvable dans le fichier genere.`); continue; }
    const cible = extraire(app, `const ${nom}`);
    if (!cible) { console.warn(`  ${nom} : introuvable dans app.js.`); continue; }

    const avant = Object.keys(JSON.parse(cible.litteral)).length;
    const apres = Object.keys(JSON.parse(source.litteral)).length;
    app = app.slice(0, cible.debut) + source.litteral + app.slice(cible.fin);
    total++;
    console.log(`  ${nom.padEnd(28)} ${String(avant).padStart(5)} -> ${String(apres).padStart(5)} entrees`);
  }
}

writeFileSync(APP, app);
console.log(`\n${total} tables injectees dans app.js.`);
