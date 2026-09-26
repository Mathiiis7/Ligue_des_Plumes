#!/usr/bin/env node
/*
  agreger-si-lv.mjs - Regroupe les communes slovenes et lettones dans leurs regions
  officielles : 12 regions statistiques pour la Slovenie, 5 regions de planification pour
  la Lettonie.

  eBird y descend a la commune - 193 et 119 zones, soit 104 et 546 km2 chacune quand un
  departement francais en fait 5 450. Illisible sur une carte de fiche espece.

  Le rattachement commune -> region vient du champ region de Natural Earth, fige ici dans
  si-lv-communes.json pour que le script tourne sans retelecharger les 39 Mo du fichier.

  L agregation est exacte : la frequence eBird vaut listes citant l espece / listes
  totales, donc la somme ponderee par le nombre de listes de chaque commune redonne la
  vraie frequence regionale. Le bar chart fournit ce compte.

  Ces deux pays sont absents de la table REGIONS de build-rarity-multi-country.mjs : ce
  script ecrit le meme fichier et serait ecrase.

  Usage : node tools/build/agreger-si-lv.mjs
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, 'tools', 'ebird-barcharts-raw');
const SD = join(ROOT, 'tools', 'build');
const carte = JSON.parse(readFileSync(join(SD, 'si-lv-communes.json'), 'utf8'));

const TOKEN = 'dbflh4atmsom';
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species',
  { headers: { 'X-eBirdApiToken': TOKEN } })).json();
const parNom = new Map();
for(const t of tax) if(t.comName) parNom.set(t.comName.toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').trim(), (t.sciName || '').toLowerCase());

const lire = (code) => {
  const p = join(RAW, `ebird-barchart-${code}-2019-2026.txt`);
  if(!existsSync(p)) return null;
  const lignes = readFileSync(p, 'utf8').split(/\r?\n/);
  const ls = lignes.find(l => /^Sample Size/i.test(l));
  if(!ls) return null;
  const effort = ls.split('\t').slice(1).map(Number).filter(x => !isNaN(x));
  if(effort.length < 48) return null;
  const esp = {};
  for(const ln of lignes){
    if(!ln.includes('\t')) continue;
    const p2 = ln.split('\t');
    const nm = p2[0].trim();
    const nums = p2.slice(1).map(Number).filter(x => !isNaN(x));
    if(!nm || nums.length < 48 || /sample size/i.test(nm)) continue;
    const sci = parNom.get(nm.replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase());
    if(sci) esp[sci] = nums.slice(0, 48);
  }
  return { effort, esp };
};

for(const cc of ['SI', 'LV']){
  const communes = carte.parCommune[cc];
  const parRegion = {};                  // region -> { effort[48], esp: {sci: [48 sommes]} }
  let lues = 0;
  for(const [commune, region] of Object.entries(communes)){
    const d = lire(commune);
    if(!d) continue;
    lues++;
    const r = (parRegion[region] ||= { effort: new Array(48).fill(0), esp: {} });
    for(let i = 0; i < 48; i++) r.effort[i] += d.effort[i] || 0;
    for(const [sci, q48] of Object.entries(d.esp)){
      const acc = (r.esp[sci] ||= new Array(48).fill(0));
      // frequence x listes = nombre de listes citant l'espece
      for(let i = 0; i < 48; i++) acc[i] += (q48[i] || 0) * (d.effort[i] || 0);
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
    if(Object.keys(m).length) sortie[region] = m;
  }
  const out = join(ROOT, 'data', 'countries', cc.toLowerCase(), 'freq_by_region.json');
  writeFileSync(out, JSON.stringify(sortie));
  const listes = Object.values(parRegion).map(r => r.effort.reduce((a,b)=>a+b,0));
  console.log(`${cc} : ${lues} communes lues -> ${Object.keys(sortie).length} regions`);
  console.log(`     listes par region : ${listes.map(v=>Math.round(v)).sort((a,b)=>b-a).join(', ')}`);
  console.log(`     especes : ${Object.values(sortie).map(v=>Object.keys(v).length).join(', ')}`);
}
