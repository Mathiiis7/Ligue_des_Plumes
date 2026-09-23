#!/usr/bin/env node
/*
  inject-exotic-per-country.mjs - Injecte EXOTIQUES_EBIRD_PAR_PAYS dans app.js depuis
  le scrape national (scrape-ebird-exotic.mjs, fenetre 2019-2026).

  LA REGLE DE FUSION, ET POURQUOI ELLE N'EST PAS UN SIMPLE REMPLACEMENT
  ---------------------------------------------------------------------
  Le scrape lit les icones exotiques du bar chart eBird. Une espece qui n'a AUCUNE ligne
  dans le bar chart 2019-2026 n'a donc aucune icone a lire : elle ressort non taggee. Ce
  n'est pas eBird qui la declare sauvage, c'est nous qui n'avons rien lu.

  Or le tier de rarete, lui, survit dans REAL_RARITY (herite d'une fenetre anterieure).
  Un remplacement sec ferait donc basculer ces especes d'"exotique, tier 0, grisee" a
  "sauvage avec une vraie rarete" : le Faucon laggar, rapace de fauconnerie echappe,
  deviendrait une mega-rarete sauvage francaise au tier 9. Le Bulbul orphee, le
  Dendrocygne a ventre noir et la Bernache de Hutchins suivaient le meme chemin.

  D'ou la regle :
    - le tag frais gagne toujours ;
    - un ancien tag survit SI ET SEULEMENT SI l'espece n'a pas de ligne dans le bar chart
      courant, teste sur REAL_FREQ_MONTHLY_<CC> (reconstruit sur 2019-2026).
  Autrement dit : on ne retire un tag que quand eBird a bien regarde et n'a rien marque.

  Mesure au moment de l'ecriture de ce script : 19 especes conservent leur tag par cette
  regle (dont les 4 francaises), et 38 le perdent legitimement, surtout en Australie et
  aux Etats-Unis, ou elles apparaissent bien dans le bar chart sans icone exotique.

  Usage : node tools/build/inject-exotic-per-country.mjs [--dry]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'app.js');
const GEN = join(ROOT, 'tools', 'build', 'exotic-per-country-scraped.generated.js');
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

let app = readFileSync(APP, 'utf8');
const cible = extraire(app, 'EXOTIQUES_EBIRD_PAR_PAYS = ');
if (!cible) { console.error('EXOTIQUES_EBIRD_PAR_PAYS introuvable dans app.js.'); process.exit(1); }
const ancien = JSON.parse(cible.litteral);
const frais = lire(readFileSync(GEN, 'utf8'), 'EXOTIQUES_EBIRD_SCRAPED = ');
if (!frais) { console.error('EXOTIQUES_EBIRD_SCRAPED absent du fichier scrape.'); process.exit(1); }

// Presence dans le bar chart courant, par pays.
const mensuel = {};
for (const cc of Object.keys(ancien)) {
  mensuel[cc] = lire(app, cc === 'FR' ? 'const REAL_FREQ_MONTHLY = ' : `const REAL_FREQ_MONTHLY_${cc} = `) || {};
}
const auBarChart = (cc, sci) => {
  const a = mensuel[cc][sci];
  return Array.isArray(a) && Math.max(...a) > 0;
};

const fusion = {};
let gardes = 0, retires = 0, ajoutes = 0;
const detailGardes = [];
for (const cc of Object.keys(ancien)) {
  const out = { ...(frais[cc] || {}) };
  for (const [sci, cat] of Object.entries(ancien[cc])) {
    if (out[sci]) continue;
    if (auBarChart(cc, sci)) { retires++; continue; }   // eBird a regarde : sauvage
    out[sci] = cat; gardes++;                            // rien a lire : on garde
    detailGardes.push(`${cc} ${sci} (${cat})`);
  }
  for (const sci of Object.keys(frais[cc] || {})) if (!ancien[cc][sci]) ajoutes++;
  fusion[cc] = out;
}

const n = o => Object.entries(o).map(([k, v]) => `${k}:${Object.keys(v).length}`).join(' ');
console.log(`avant  ${n(ancien)}`);
console.log(`scrape ${n(frais)}`);
console.log(`apres  ${n(fusion)}`);
console.log(`\n${retires} tags retires (ligne presente au bar chart, sans icone exotique).`);
console.log(`${gardes} tags conserves (aucune ligne au bar chart : rien a lire).`);
console.log(`${ajoutes} tags ajoutes par le scrape.`);
console.log(`\nConserves : ${detailGardes.slice(0, 25).join(', ')}${detailGardes.length > 25 ? '...' : ''}`);

if (DRY) { console.log('\n--dry : app.js non modifie.'); process.exit(0); }
app = app.slice(0, cible.debut) + JSON.stringify(fusion) + app.slice(cible.fin);
writeFileSync(APP, app);
console.log('\napp.js mis a jour.');
