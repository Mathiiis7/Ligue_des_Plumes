#!/usr/bin/env node
/*
  inject-exotic-by-region.mjs - Fusionne les tables exotic-by-region-<cc>.generated.js
  produites par scrape-exotic-by-region-multi.mjs (+ la table FR historique) dans un
  unique dict EXOTIC_STATUS_BY_REGION_MULTI injecte dans app.js.

  Format cible :
    const EXOTIC_STATUS_BY_REGION_MULTI = { "FR": { "FR-ARA": { "sci name": "N" } }, ... };

  Idempotent : relancer apres avoir complete un pays remplace le bloc existant.

  Usage : node tools/build/inject-exotic-by-region.mjs
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP = join(__dir, '..', '..', 'app.js');

const CCS = ['FR','GB','ES','IT','PT','CH','NO','GR','IS','LK','NA','AU','NZ','US','CA'];

const merged = {};
for(const cc of CCS){
  const f = join(__dir, `exotic-by-region-${cc.toLowerCase()}.generated.js`);
  if(!existsSync(f)){ console.warn(`  ${cc} : fichier absent, skip.`); continue; }
  const src = readFileSync(f, 'utf8');
  const m = src.match(new RegExp(`EXOTIC_STATUS_BY_REGION_${cc}\\s*=\\s*(\\{[\\s\\S]*?\\});`));
  if(!m){ console.warn(`  ${cc} : pattern introuvable, skip.`); continue; }
  const data = JSON.parse(m[1]);
  // Une region presente avec un objet vide a bien ete scrapee et n'a simplement aucune
  // exotique : on la garde, c'est justement la qu'une espece peut etre native. Le scraper
  // supprime la cle des regions en echec, donc "absent du dict" = "pas encore scrape".
  merged[cc] = data;
  const tot = Object.values(data).reduce((a, o) => a + Object.keys(o).length, 0);
  const empty = Object.values(data).filter(o => !Object.keys(o).length).length;
  console.log(`  ${cc} : ${Object.keys(data).length} regions, ${tot} entrees` + (empty ? ` (dont ${empty} sans exotique)` : ''));
}

// ---------------------------------------------------------------------------
// Derive : especes taggees X/P au niveau NATIONAL mais qui ont au moins une region ou
// elles sont (a) presentes dans le bar chart regional ET (b) absentes des tags exotiques
// de cette region => eBird les considere natives la-bas, le tag national est trompeur.
// Precalcule ici plutot qu'au runtime : evite de dependre du lazy-load de freq_by_region
// cote client et permet d'afficher la liste des regions natives dans la fiche.
// ---------------------------------------------------------------------------
function readNationalExotics(appSrc){
  const m = appSrc.match(/const EXOTIQUES_EBIRD_PAR_PAYS = (\{[\s\S]*?\});/);
  if(!m) throw new Error('EXOTIQUES_EBIRD_PAR_PAYS introuvable dans app.js');
  return JSON.parse(m[1]);
}

// Nombre de mois de presence exiges dans une region pour la considerer comme native
// malgre un tag exotique national. Aligne sur _MOIS_MIN_X_VISIBLE cote app, qui ecarte de
// la meme facon les echappees trop ponctuelles.
const MOIS_MIN_NATIF = 6;

function computeNativeRegions(appSrc){
  const national = readNationalExotics(appSrc);
  const out = {};
  for(const cc of Object.keys(merged)){
    const freqFile = join(__dir, '..', '..', 'data', 'countries', cc.toLowerCase(), 'freq_by_region.json');
    if(!existsSync(freqFile)) continue;
    const freq = JSON.parse(readFileSync(freqFile, 'utf8'));
    const exoByRegion = merged[cc];
    const natTags = national[cc] || {};
    const perSpecies = {};
    for(const [sci, cat] of Object.entries(natTags)){
      if(cat !== 'X' && cat !== 'P') continue;   // N = tag legitime, on n'y touche pas
      const nativeIn = [];
      for(const [region, byS] of Object.entries(exoByRegion)){
        // (b) pas de tag exotique dans cette region
        if(byS[sci]) continue;
        // (a) presente dans le bar chart de cette region, et pas juste de passage.
        //
        // Exiger "au moins une valeur > 0" ne suffisait pas : une seule observation suffisait
        // a decreter l'espece native. En France, 28 des 34 exceptions ainsi accordees ne
        // reposaient que sur UN mois de l'annee, et 25 sur la valeur plancher d'eBird
        // (0,15 % = "vu au moins une fois, sous le seuil de report"). Ca donnait un statut
        // de sauvage a des oiseaux de cage : Perroquet jaco, Diamant mandarin, Inseparables,
        // Ibis rouge, flamants et pelicans ornementaux.
        //
        // Le cas que cette exception doit servir est l'inverse : une espece vraiment installee
        // dans une region, comme l'Oie empereur en Alaska ou le Bruant chanteur dans 49 Etats.
        // Ces oiseaux-la sont presents toute l'annee ou sur une vraie saison. Le seuil de
        // MOIS_MIN_NATIF mois conserve 54 des 56 cas australiens et 172 des 233 americains,
        // dont l'Oie empereur, et ecarte 33 des 34 francais.
        const arr = freq[region] && freq[region][sci];
        if(!Array.isArray(arr)) continue;
        if(arr.filter(v => v > 0).length < MOIS_MIN_NATIF) continue;
        nativeIn.push(region);
      }
      if(nativeIn.length) perSpecies[sci] = nativeIn;
    }
    if(Object.keys(perSpecies).length) out[cc] = perSpecies;
  }
  return out;
}

const HEADER = [
  '// Statut exotique par region, 15 pays. Genere par tools/build/scrape-exotic-by-region-multi.mjs',
  "// (+ scrape-exotic-by-region-fr.mjs pour FR) puis fusionne par tools/build/inject-exotic-by-region.mjs.",
  '// Format : { cc: { "XX-YY": { sciName: "N"|"P"|"X" } } }. Une region absente du dict n\'a',
  "// aucune exotique listee -> toute espece presente y est consideree native par eBird.",
].join('\n');

let app = readFileSync(APP, 'utf8');

const nativeRegions = computeNativeRegions(app);
console.log('\nEspeces taggees X/P au national mais natives dans >= 1 region :');
for(const [cc, sp] of Object.entries(nativeRegions)) console.log(`  ${cc} : ${Object.keys(sp).length}`);

const NATIVE_HEADER = [
  '// Especes taggees X (Echappe) ou P (Provisoire) au niveau NATIONAL par eBird mais qui',
  '// sont en fait natives dans au moins une region du pays : presentes dans le bar chart',
  "// regional ET sans tag exotique pour cette region. Le tag national est alors trompeur",
  '// (ex : Oie empereur = X aux US car echappee sur le continent, mais native en Alaska ;',
  '// Bruant chanteur = P aux US alors qu\'il niche dans 49 etats).',
  '// Format : { cc: { sciName: ["XX-YY", ...] } }. Precalcule par inject-exotic-by-region.mjs.',
].join('\n');

const block = `${HEADER}\nconst EXOTIC_STATUS_BY_REGION_MULTI = ${JSON.stringify(merged)};\n` +
              `${NATIVE_HEADER}\nconst NATIVE_REGIONS_DESPITE_NATIONAL_TAG = ${JSON.stringify(nativeRegions)};\n`;

// Remplace un bloc MULTI existant, sinon remplace l'ancienne table FR seule.
// Le bloc NATIVE_REGIONS est optionnel : absent lors de la premiere migration depuis
// la table FR seule, present sur les reinjections suivantes.
const reMulti = /\/\/ Statut exotique par region, \d+ pays\.[\s\S]*?\nconst EXOTIC_STATUS_BY_REGION_MULTI = \{[\s\S]*?\};\n(?:(?:\/\/[^\n]*\n)*const NATIVE_REGIONS_DESPITE_NATIONAL_TAG = \{[\s\S]*?\};\n)?/;
const reFrOnly = /const EXOTIC_STATUS_BY_REGION_FR = \{[\s\S]*?\};\n/;

if(reMulti.test(app)){
  app = app.replace(reMulti, block);
  console.log('\nBloc MULTI existant remplace.');
} else if(reFrOnly.test(app)){
  app = app.replace(reFrOnly, block);
  console.log('\nAncienne table EXOTIC_STATUS_BY_REGION_FR remplacee par le dict MULTI.');
} else {
  console.error('\nERREUR : ni bloc MULTI ni table FR trouves dans app.js. Rien ecrit.');
  process.exit(1);
}

writeFileSync(APP, app);
const totalEntries = Object.values(merged).reduce((a, byR) =>
  a + Object.values(byR).reduce((b, o) => b + Object.keys(o).length, 0), 0);
console.log(`Ecrit app.js : ${Object.keys(merged).length} pays, ${totalEntries} entrees, ${(block.length/1024).toFixed(1)} KB.`);
