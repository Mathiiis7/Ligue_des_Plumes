#!/usr/bin/env node
/*
  build-exotic-per-country.mjs — Statut exotique par pays depuis eBird API.

  eBird Public API v2 renvoie un champ `exoticCategory` sur chaque observation :
    N = Naturalized (population etablie durable)
    P = Provisional (obs regulieres mais pop non confirmee)
    X = Escapee (individu(s) echappe(s))
    C = obsolete alias, garde au cas ou

  Endpoint utilise : /data/obs/{regionCode}/recent?back=30&includeProvisional=true
  Retourne une entree par ESPECE (la plus recente obs), sur 30 jours. Une seule
  requete API par pays. Rapide et fiable pour tous les exotiques regulierement
  observes.

  LIMITE : exotiques tres rares non observes sur les 30 derniers jours seront
  absents. En pratique tres peu d'oiseaux : les exotiques etablis sont observes
  quotidiennement. Pour combler on merge avec le dict EXOTIC curatorial deja
  present dans index.html (fallback).

  SORTIE : tools/exotic-per-country.generated.js
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'exotic-per-country.generated.js');
const KEY = 'dbflh4atmsom';
const COUNTRIES = ['FR', 'ME', 'ES', 'IT', 'GB', 'PT'];

// Charge REAL_RARITY (bar chart eBird FR) pour discriminer les vrais exotiques des
// especes sauvages courantes qui apparaissent une fois marquees X (override individuel
// d'un observateur qui a note "cet individu etait captif" sur une espece par ailleurs
// sauvage : cas de anser albifrons, anser erythropus, etc.).
const rarSrc = readFileSync(join(__dir, 'real-rarity.generated.js'), 'utf8');
const rarMatch = rarSrc.match(/REAL_RARITY\s*=\s*(\{[\s\S]*?\})\s*;/);
const REAL_RARITY = rarMatch ? JSON.parse(rarMatch[1]) : {};
console.log(`Charge ${Object.keys(REAL_RARITY).length} entrees REAL_RARITY pour filtre X.`);

async function fetchJSON(url){
  const r = await fetch(url, { headers: { 'X-eBirdApiToken': KEY } });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const result = {};
for(const cc of COUNTRIES){
  process.stdout.write(`Fetch ${cc}... `);
  const obs = await fetchJSON(
    `https://api.ebird.org/v2/data/obs/${cc}/recent?back=30&includeProvisional=true`
  );
  const exotics = {};
  const skipped = [];
  for(const o of obs){
    if(!o.exoticCategory || !o.sciName) continue;
    const k = o.sciName.toLowerCase();
    // Hybrides (contient " x ") : on jette, on ne les affiche pas dans l'app.
    if(k.includes(' x ')) continue;
    // FR uniquement : si l'espece est dans REAL_RARITY (calibree comme sauvage
    // reguliere) ET flaggee X, c'est un override individuel d'obs -> ignore.
    // On garde N et P qui refletent le statut regional officiel.
    if(cc === 'FR' && o.exoticCategory === 'X' && REAL_RARITY[k]){
      skipped.push(k); continue;
    }
    // Pigeon biset : eBird considere la forme ferale urbaine comme "Naturalized" mais
    // en pratique on veut le traiter comme espece normale (les pigeons de ville sont
    // les seuls pigeons bisets qu'on voit, pas une distinction utile ici).
    if(k === 'columba livia'){ skipped.push(k); continue; }
    exotics[k] = o.exoticCategory;
  }
  process.stdout.write(`${obs.length} obs, ${Object.keys(exotics).length} exotiques (skip ${skipped.length} X sur sauvages)\n`);
  result[cc] = exotics;
}

writeFileSync(OUT,
  `// Genere par tools/build-exotic-per-country.mjs depuis eBird API v2.\n` +
  `// Ne pas editer a la main. Regenerable : node tools/build-exotic-per-country.mjs\n` +
  `//\n` +
  `// Format : { regionCode: { sciName: category } }\n` +
  `// Categorie eBird : N (Naturalized) | P (Provisional) | X (Escapee) | C (obsolete)\n` +
  `//\n` +
  `// Source : field exoticCategory du /v2/data/obs/{region}/recent?back=30\n` +
  `// (une entree par espece, la plus recente sur 30 jours).\n` +
  `//\n` +
  `// LIMITE : exotiques rares non observes sur 30 derniers jours peuvent manquer.\n` +
  `// index.html merge ce dict avec la liste EXOTIC curatorial en fallback.\n` +
  `export const EXOTIC_BY_COUNTRY = ${JSON.stringify(result)};\n`
);
console.log(`\n✓ Ecrit ${OUT}`);
for(const cc of COUNTRIES){
  const cats = {};
  for(const v of Object.values(result[cc])) cats[v] = (cats[v]||0) + 1;
  console.log(`  ${cc} :`, cats);
}
