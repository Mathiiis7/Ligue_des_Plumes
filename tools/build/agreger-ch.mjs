#!/usr/bin/env node
/*
  agreger-ch.mjs - Regroupe les 26 cantons suisses dans les 7 grandes regions de l'Office
  federal de la statistique (niveau NUTS-2), et ecrit data/countries/ch/freq_by_region.json.

  POURQUOI
  Un canton fait 1 588 km2 en moyenne, deux fois plus fin qu'un departement francais. Ce
  n'est pas la donnee qui manque - la mediane est de 3 272 listes par canton, la meilleure
  de l'appli - c'est l'echelle qui est trop fine pour une carte de fiche espece.

  L'AGREGATION EST EXACTE, PAS APPROCHEE
  La frequence eBird vaut « listes citant l'espece / listes totales ». La somme ponderee par
  le nombre de listes de chaque canton redonne donc la vraie frequence regionale, et le bar
  chart fournit ce compte dans sa ligne « Sample Size ».

  A RELANCER apres tout build-rarity-multi-country.mjs si la Suisse y revenait : ce script
  ecrit le meme fichier. La Suisse est pour cette raison absente de la table REGIONS de
  build-rarity-multi-country.mjs.

  Usage : node tools/build/agreger-ch.mjs
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const RAW = join(ROOT, 'tools', 'ebird-barcharts-raw');
const TOKEN = 'dbflh4atmsom';   // meme jeton que les autres scripts eBird du dossier

// Les 7 grandes regions. Table verifiee le 2026-09-26 : 26 cantons cites, 26 uniques, 26
// retrouves dans Natural Earth, et chaque groupe forme un bloc geographique compact.
export const GRANDES_REGIONS = {
  'CH-R1': { nom: 'Région lémanique',     cantons: ['CH-VD','CH-VS','CH-GE'] },
  'CH-R2': { nom: 'Espace Mittelland',    cantons: ['CH-BE','CH-FR','CH-SO','CH-NE','CH-JU'] },
  'CH-R3': { nom: 'Suisse du Nord-Ouest', cantons: ['CH-BS','CH-BL','CH-AG'] },
  'CH-R4': { nom: 'Zurich',               cantons: ['CH-ZH'] },
  'CH-R5': { nom: 'Suisse orientale',     cantons: ['CH-GL','CH-SH','CH-AR','CH-AI','CH-SG','CH-GR','CH-TG'] },
  'CH-R6': { nom: 'Suisse centrale',      cantons: ['CH-LU','CH-UR','CH-SZ','CH-OW','CH-NW','CH-ZG'] },
  'CH-R7': { nom: 'Tessin',               cantons: ['CH-TI'] },
};

const parCanton = {};
for(const [code, r] of Object.entries(GRANDES_REGIONS)) for(const c of r.cantons) parCanton[c] = code;

const tax = await (await fetch(
  'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species',
  { headers: { 'X-eBirdApiToken': TOKEN } })).json();
const parNom = new Map();
for(const t of tax) if(t.comName)
  parNom.set(t.comName.toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').trim(), (t.sciName || '').toLowerCase());

const parRegion = {};
let lus = 0;
for(const [canton, region] of Object.entries(parCanton)){
  const p = join(RAW, `ebird-barchart-${canton}-2019-2026.txt`);
  if(!existsSync(p)){ console.warn(`  ${canton} : bar chart absent`); continue; }
  const lignes = readFileSync(p, 'utf8').split(/\r?\n/);
  const ls = lignes.find(l => /^Sample Size/i.test(l));
  if(!ls) continue;
  const eff = ls.split('\t').slice(1).map(Number).filter(x => !isNaN(x));
  if(eff.length < 48) continue;
  lus++;
  const r = (parRegion[region] ||= { effort: new Array(48).fill(0), esp: {} });
  for(let i = 0; i < 48; i++) r.effort[i] += eff[i] || 0;
  for(const ln of lignes){
    if(!ln.includes('\t')) continue;
    const p2 = ln.split('\t'), nm = p2[0].trim();
    const nums = p2.slice(1).map(Number).filter(x => !isNaN(x));
    if(!nm || nums.length < 48 || /sample size/i.test(nm)) continue;
    const sci = parNom.get(nm.replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase());
    if(!sci) continue;
    // frequence x nombre de listes = nombre de listes citant l'espece
    const acc = (r.esp[sci] ||= new Array(48).fill(0));
    for(let i = 0; i < 48; i++) acc[i] += (nums[i] || 0) * (eff[i] || 0);
  }
}

const sortie = {};
for(const [region, r] of Object.entries(parRegion)){
  const m = {};
  for(const [sci, acc] of Object.entries(r.esp)){
    const m12 = new Array(12).fill(0);
    for(let mo = 0; mo < 12; mo++){
      let num = 0, den = 0;
      for(let k = 0; k < 4; k++){ num += acc[mo*4+k]; den += r.effort[mo*4+k]; }
      m12[mo] = den > 0 ? +(num/den).toFixed(5) : 0;
    }
    if(m12.some(v => v > 0)) m[sci] = m12;
  }
  sortie[region] = m;
}

writeFileSync(join(ROOT, 'data', 'countries', 'ch', 'freq_by_region.json'), JSON.stringify(sortie));
console.log(`${lus} cantons lus -> ${Object.keys(sortie).length} grandes regions`);
for(const [c, r] of Object.entries(parRegion))
  console.log(`  ${c} ${GRANDES_REGIONS[c].nom.padEnd(22)} `
    + `${String(Math.round(r.effort.reduce((a,b)=>a+b,0))).padStart(6)} listes, `
    + `${Object.keys(sortie[c]).length} especes`);
