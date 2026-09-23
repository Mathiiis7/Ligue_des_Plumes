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

const TOUS = ['FR','ES','IT','GB','PT','CH','NO','GR','IS','LK','NA','AU','NZ','US','CA'];

// La France nomme ses tables sans suffixe de pays, et on FUSIONNE au lieu de remplacer :
// REAL_RARITY porte 8 anciennes cles de genre (bubulcus ibis, accipiter gentilis,
// charadrius dubius...) absentes du bar chart courant et sans entree dans SCI_ALIAS. Du
// code peut les interroger directement ; un remplacement sec les perdrait.
const NOMS_TABLES = { FR: { rarete: 'REAL_RARITY', mensuel: 'REAL_FREQ_MONTHLY' } };
const FUSIONNE = new Set(['FR']);
const nomRarete = cc => (NOMS_TABLES[cc] && NOMS_TABLES[cc].rarete) || ('REAL_RARITY_' + cc + '_EBIRD');
const nomMensuel = cc => (NOMS_TABLES[cc] && NOMS_TABLES[cc].mensuel) || ('REAL_FREQ_MONTHLY_' + cc);
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

  for (const nom of [nomRarete(cc), nomMensuel(cc)]) {
    const source = extraire(gen, nom);
    if (!source) { console.warn(`  ${nom} : introuvable dans le fichier genere.`); continue; }
    const cible = extraire(app, `const ${nom}`);
    if (!cible) { console.warn(`  ${nom} : introuvable dans app.js.`); continue; }

    const ancien = JSON.parse(cible.litteral);
    const neuf = JSON.parse(source.litteral);
    const avant = Object.keys(ancien).length;
    let conserves = 0;
    if (FUSIONNE.has(cc)) {
      for (const k of Object.keys(ancien)) if (!(k in neuf)) { neuf[k] = ancien[k]; conserves++; }
    }
    const apres = Object.keys(neuf).length;
    app = app.slice(0, cible.debut) + JSON.stringify(neuf) + app.slice(cible.fin);
    total++;
    const suffixe = conserves ? `  (${conserves} anciennes cles conservees)` : '';
    console.log(`  ${nom.padEnd(28)} ${String(avant).padStart(5)} -> ${String(apres).padStart(5)} entrees${suffixe}`);
  }
}

writeFileSync(APP, app);
console.log(`\n${total} tables injectees dans app.js.`);
