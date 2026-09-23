#!/usr/bin/env node
/*
  purge-tiers-sans-barchart-fr.mjs - Retire de REAL_RARITY (France) les tiers qu'aucune
  ligne du bar chart eBird 2019-2026 ne soutient.

  Ces entrees viennent d'une fenetre anterieure : REAL_RARITY a ete recalibre sur l'echelle
  a 10 tiers mais son generateur d'origine travaillait sur 2015-2026 et retombait sur GBIF
  quand eBird ne disait rien. Des especes affichaient donc un tier 7 a 10 sans qu'aucune
  donnee courante ne l'appuie.

  Ce n'est pas cosmetique : un tier sans tag exotique se lit comme "sauvage, rare". C'est
  ainsi que la Perdrix choukar, le Dindon sauvage et le Francolin noir, tous des gibiers
  laches, se presentaient comme des raretes francaises.

  PRESENCE = UNE LIGNE, PAS UNE FREQUENCE NON NULLE
  L'Oie naine a bien une ligne au bar chart, dont les 49 valeurs sont a zero. eBird la porte
  donc sur la liste francaise tout en ne la rapportant jamais sur la fenetre : c'est une
  information, pas une absence, et son tier 10 est legitime. Une espece sans aucune ligne,
  elle, n'est pas mesuree du tout.

  Les exotiques gardent leur entree : elles sont deja au tier 0 par leur categorie, et leur
  retirer le tier les sortirait du birdydex ou elles doivent rester visibles en grise.

  Usage : node tools/build/purge-tiers-sans-barchart-fr.mjs [--dry]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP = join(__dir, '..', '..', 'app.js');
const TSV = join(__dir, '..', 'ebird-barcharts-raw', 'ebird-barchart-FR-2019-2026.txt');
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
const lire = (src, decl) => { const e = extraire(src, decl); return e ? JSON.parse(e.litteral) : null; };

const norm = x => x.toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]/g, '');

let app = readFileSync(APP, 'utf8');
const cible = extraire(app, 'const REAL_RARITY = ');
if (!cible) { console.error('REAL_RARITY introuvable.'); process.exit(1); }
const tiers = JSON.parse(cible.litteral);
const mensuel = lire(app, 'const REAL_FREQ_MONTHLY = ') || {};
const noms = lire(app, 'const FR_NAMES = ') || {};
const exo = (lire(app, 'EXOTIQUES_EBIRD_PAR_PAYS = ') || {}).FR || {};

const lignesTSV = new Set();
for (const ln of readFileSync(TSV, 'utf8').split(/\r?\n/)) {
  if (!ln.includes('\t')) continue;
  const p = ln.split('\t');
  const nm = p[0].trim();
  const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
  if (!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
  lignesTSV.add(norm(nm.replace(/\s*\(.*?\)\s*/g, ' ').trim()));
}

const auBarChart = k => (Array.isArray(mensuel[k]) && Math.max(...mensuel[k]) > 0)
  || lignesTSV.has(norm(noms[k] || k));

const retires = [], gardesExo = [], gardesZero = [];
for (const k of Object.keys(tiers)) {
  if (Array.isArray(mensuel[k]) && Math.max(...mensuel[k]) > 0) continue;
  if (exo[k]) { gardesExo.push(`${noms[k] || k} (${exo[k]})`); continue; }
  if (auBarChart(k)) { gardesZero.push(`${noms[k] || k} (tier ${tiers[k]})`); continue; }
  retires.push([noms[k] || k, tiers[k]]);
  delete tiers[k];
}

retires.sort((a, b) => a[1] - b[1]);
console.log(`${retires.length} tiers retires, sans aucune ligne au bar chart 2019-2026 :\n`);
for (const [n, t] of retires) console.log(`  tier ${String(t).padStart(2)}  ${n}`);
console.log(`\nligne presente mais a 0 %, tier conserve : ${gardesZero.join(', ') || 'aucune'}`);
console.log(`exotiques conservees : ${gardesExo.join(', ') || 'aucune'}`);
console.log(`REAL_RARITY : ${retires.length + Object.keys(tiers).length} -> ${Object.keys(tiers).length} entrees.`);

if (DRY) { console.log('\n--dry : app.js non modifie.'); process.exit(0); }
app = app.slice(0, cible.debut) + JSON.stringify(tiers) + app.slice(cible.fin);
writeFileSync(APP, app);
console.log('\napp.js mis a jour.');
