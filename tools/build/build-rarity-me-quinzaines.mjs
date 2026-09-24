#!/usr/bin/env node
/*
  build-rarity-me-quinzaines.mjs - remplace build-rarity-me-ebird.mjs.

  A lancer depuis la racine du depot : node tools/build/build-rarity-me-quinzaines.mjs [--ecrire]
  Sans --ecrire, compare et n ecrit rien.

  Entree  : tools/ebird-barcharts-raw/ebird-barchart-ME-2019-2026.txt
  Sortie  : REAL_RARITY_ME_EBIRD, REAL_FREQ_MONTHLY_ME et EFFORT_MENSUEL_PAR_PAYS.ME, dans app.js
*/
// Recalcule le Montenegro comme les 15 autres pays : moyenne des 48 quinzaines ponderee par
// le nombre de listes de chacune, convertie par _ANNUAL_THR. Ses tables venaient d'un script
// a part qui prenait le PIC des 48 quinzaines et l'ancienne table mensuelle.
//
// Ecrit seulement si --ecrire est passe. Sans l'option, compare et n'ecrit rien.
import { readFileSync, writeFileSync } from 'fs';
const ECRIRE = process.argv.includes('--ecrire');
const RE = new RegExp('\r?\n');
const src = readFileSync('app.js', 'utf8');

const norm = s => String(s).toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]/g, '');

const litObjet = (texte, nom) => {
  const i = texte.indexOf('const ' + nom + ' = {');
  if(i < 0) throw new Error('introuvable : ' + nom);
  let d = texte.indexOf('{', i), prof = 0, j = d;
  for(; j < texte.length; j++){
    if(texte[j] === '{') prof++;
    else if(texte[j] === '}'){ prof--; if(!prof) break; }
  }
  return { debut: d, fin: j + 1, obj: JSON.parse(texte.slice(d, j + 1)) };
};
// BAR_CHART_ALIAS vit dans le script ME, en plusieurs lignes et avec des quotes JS
const srcME = readFileSync('tools/build/build-rarity-me-ebird.mjs', 'utf8');
const ALIAS = (() => {
  const i = srcME.indexOf('const BAR_CHART_ALIAS = {');
  let d = srcME.indexOf('{', i), prof = 0, j = d;
  for(; j < srcME.length; j++){
    if(srcME[j] === '{') prof++;
    else if(srcME[j] === '}'){ prof--; if(!prof) break; }
  }
  return new Function('return ' + srcME.slice(d, j + 1))();
})();

const INVERSE = Object.fromEntries(Object.entries(ALIAS).map(([k, v]) => [v, k]));
const FR_NAMES = litObjet(src, 'FR_NAMES').obj;      // sci -> nom francais
const frVersSci = {};
for(const [sci, fr] of Object.entries(FR_NAMES)) frVersSci[norm(fr)] = sci.toLowerCase();

// --- bar chart ---
const lignes = readFileSync('tools/ebird-barcharts-raw/ebird-barchart-ME-2019-2026.txt', 'utf8').split(RE);
let effort = null;
const brut = [];
for(const ln of lignes){
  if(!ln.includes('\t')) continue;
  const p = ln.split('\t');
  const nm = p[0].trim();
  const v = p.slice(1, 49).map(x => Number(x) || 0);
  if(/^sample size/i.test(nm)){ effort = v; continue; }
  if(!nm || v.length !== 48) continue;
  brut.push({ nom: nm.replace(/\s*\(.*?\)\s*/g, ' ').trim(), v });
}
if(!effort) throw new Error('ligne Sample Size absente');
console.log('bar chart ME : ' + brut.length + ' taxons, ' + effort.reduce((a, b) => a + b, 0).toLocaleString('fr') + ' listes sur 2019-2026');

// --- profil d'effort mensuel : part des listes de l'annee tombant dans chaque mois ---
const totalListes = effort.reduce((a, b) => a + b, 0);
const effMois = [...Array(12)].map((_, m) => effort.slice(m * 4, m * 4 + 4).reduce((a, b) => a + b, 0) / totalListes);
console.log('effort mensuel ME : ' + effMois.map(x => x.toFixed(5)).join(', '));
console.log('  min ' + (Math.min(...effMois) * 100).toFixed(1) + '% du total, max ' + (Math.max(...effMois) * 100).toFixed(1) + '%');

const THR = JSON.parse(src.match(/const _ANNUAL_THR = (\[\[.*?\]\]);/)[1]);
const palier = v => { if(!(v > 0)) return 10; for(const [l, t] of THR) if(v >= l) return t; return 10; };

const tiers = {}, mois = {};
let apparies = 0; const orphelins = [];
for(const { nom, v } of brut){
  // Le bar chart 2019-2026 est servi avec les noms CINFO longs ("Pluvier grand-gravelot"),
  // FR_NAMES porte les noms courts ("Grand Gravelot"). BAR_CHART_ALIAS relie les deux ; on
  // l'essaie dans les deux sens, le scrape ayant change de locale entre-temps. Sans ca, cinq
  // especes deja presentes disparaissaient sans erreur ni avertissement.
  const sci = frVersSci[norm(nom)]
    || frVersSci[norm(ALIAS[nom] || '')]
    || frVersSci[norm(INVERSE[nom] || '')];
  if(!sci){ orphelins.push(nom); continue; }
  apparies++;
  // 12 mois : moyenne des 4 quinzaines ponderee par leurs listes, comme les autres pays
  const m12 = [...Array(12)].map((_, m) => {
    const e = effort.slice(m * 4, m * 4 + 4), f = v.slice(m * 4, m * 4 + 4);
    const den = e.reduce((a, b) => a + b, 0);
    return den ? +(f.reduce((s, x, i) => s + x * e[i], 0) / den).toFixed(5) : 0;
  });
  // annuel : la meme moyenne sur les 48 quinzaines
  const an = v.reduce((s, x, i) => s + x * effort[i], 0) / totalListes;
  tiers[sci] = palier(an);
  mois[sci] = m12;
}
console.log('apparies : ' + apparies + ' / ' + brut.length + ' (orphelins : ' + orphelins.length + ')');
if(orphelins.length) console.log('  ' + orphelins.slice(0, 10).join(' | '));

// --- comparaison avec les tables en place ---
const T0 = litObjet(src, 'REAL_RARITY_ME_EBIRD');
const M0 = litObjet(src, 'REAL_FREQ_MONTHLY_ME');
const perdus = Object.keys(T0.obj).filter(k => !(k in tiers));
const ajouts = Object.keys(tiers).filter(k => !(k in T0.obj));
console.log('');
console.log('table actuelle : ' + Object.keys(T0.obj).length + ' paliers, ' + Object.keys(M0.obj).length + ' series mensuelles');
console.log('nouvelle table : ' + Object.keys(tiers).length + ' paliers');
console.log('  especes perdues : ' + perdus.length + (perdus.length ? ' -> ' + perdus.slice(0, 10).join(', ') : ''));
console.log('  especes ajoutees : ' + ajouts.length + (ajouts.length ? ' -> ' + ajouts.slice(0, 10).join(', ') : ''));
const bouge = {};
for(const [k, t] of Object.entries(tiers)) if(k in T0.obj){ const d = t - T0.obj[k]; bouge[d] = (bouge[d] || 0) + 1; }
console.log('  deplacement de palier (nouveau - ancien) : '
  + Object.entries(bouge).sort((a, b) => a[0] - b[0]).map(([d, c]) => (d > 0 ? '+' + d : d) + ':' + c).join('  '));

if(!ECRIRE){ console.log('\n(essai a blanc, rien ecrit - relancer avec --ecrire)'); process.exit(0); }
if(perdus.length) throw new Error('refus d ecrire : ' + perdus.length + ' especes disparaitraient');

// --- ecriture ---
let s = src;
const remplacerObjet = (nom, obj) => {
  const { debut, fin } = litObjet(s, nom);
  s = s.slice(0, debut) + JSON.stringify(obj) + s.slice(fin);
};
remplacerObjet('REAL_RARITY_ME_EBIRD', tiers);
remplacerObjet('REAL_FREQ_MONTHLY_ME', mois);
// profil d'effort : le Montenegro en etait absent, la moyenne y etait donc non ponderee
const eff = litObjet(s, 'EFFORT_MENSUEL_PAR_PAYS');
if(!eff.obj.ME){
  eff.obj.ME = effMois.map(x => +x.toFixed(5));
  s = s.slice(0, eff.debut) + JSON.stringify(eff.obj) + s.slice(eff.fin);
  console.log('profil d effort ME ajoute');
}
writeFileSync('app.js', s);
console.log('app.js ecrit');
