#!/usr/bin/env node
/*
  build-habitats.mjs — Habitats par espèce, basés sur la FAMILLE eBird.

  10 catégories (assez fines pour un badge "polyvalent") :
    forestier    — forêts (feuillus, conifères, taïga, mangrove...)
    hzhumide     — marais, roselières, tourbières (eaux stagnantes végétalisées)
    eaudouce     — rivières, lacs, étangs (eau ouverte)
    pelagique    — océan large (puffins, pétrels, océanites, albatros)
    littoral     — plage, dune, port, estuaire (bord de mer)
    montagne     — falaise, alpin, tundra, haute altitude
    steppe       — steppes arides, garrigues, gr. plaines sèches (Alaudidae, Otididae...)
    bocage       — bocage, prairies humides, cultures modestes (Emberizidae, Motacillidae...)
    urbain       — ville, parc, jardin, bâtiment
    rocher       — falaises intérieures, éboulis, milieux rocheux (Tichodromidae, monticoles)

  Une famille peut appartenir à plusieurs catégories.

  Usage : node tools/build-habitats.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

const EBIRD_KEY = 'dbflh4atmsom';

// Familles → catégories app.
const FAMILY_TO_CATS = {
  // ── Zones humides (marais/roselières) ────────────────────────────────
  'Acrocephalidae': ['hzhumide'],
  'Locustellidae': ['hzhumide'],
  'Panuridae': ['hzhumide'],
  'Remizidae': ['hzhumide'],
  'Cettiidae': ['hzhumide', 'forestier'],
  'Ardeidae': ['hzhumide', 'eaudouce'],
  'Threskiornithidae': ['hzhumide', 'eaudouce'],
  'Ciconiidae': ['hzhumide', 'bocage'],
  'Rallidae': ['hzhumide', 'eaudouce'],
  'Cinclidae': ['eaudouce', 'montagne'],

  // ── Eau douce (rivière/lac/étang) ────────────────────────────────────
  'Anatidae': ['eaudouce', 'littoral'],
  'Podicipedidae': ['eaudouce'],
  'Gaviidae': ['eaudouce', 'littoral'],
  'Phoenicopteridae': ['littoral', 'hzhumide'],
  'Alcedinidae': ['eaudouce'],
  'Gruidae': ['eaudouce', 'bocage'],
  'Rostratulidae': ['eaudouce'],
  'Anhingidae': ['eaudouce'],
  'Jacanidae': ['eaudouce'],

  // ── Littoral (côte) ──────────────────────────────────────────────────
  'Laridae': ['littoral', 'eaudouce'],
  'Sternidae': ['littoral', 'eaudouce'],
  'Sulidae': ['littoral', 'pelagique'],
  'Phalacrocoracidae': ['littoral', 'eaudouce'],
  'Haematopodidae': ['littoral'],
  'Charadriidae': ['littoral', 'hzhumide', 'steppe'],
  'Scolopacidae': ['littoral', 'hzhumide'],
  'Recurvirostridae': ['littoral', 'hzhumide'],
  'Pelecanidae': ['littoral', 'eaudouce'],
  'Pandionidae': ['littoral', 'eaudouce'],

  // ── Océan / pélagique ────────────────────────────────────────────────
  'Procellariidae': ['pelagique'],
  'Diomedeidae': ['pelagique'],
  'Hydrobatidae': ['pelagique'],
  'Oceanitidae': ['pelagique'],
  'Stercorariidae': ['pelagique', 'littoral'],
  'Alcidae': ['pelagique', 'littoral'],
  'Fregatidae': ['pelagique'],
  'Phaethontidae': ['pelagique'],
  'Spheniscidae': ['pelagique', 'littoral'],

  // ── Forestier ────────────────────────────────────────────────────────
  'Picidae': ['forestier'],
  'Paridae': ['forestier', 'urbain'],
  'Sittidae': ['forestier'],
  'Certhiidae': ['forestier'],
  'Regulidae': ['forestier'],
  'Aegithalidae': ['forestier'],
  'Sylviidae': ['forestier', 'bocage'],
  'Phylloscopidae': ['forestier'],
  'Strigidae': ['forestier', 'bocage'],
  'Cuculidae': ['forestier', 'bocage'],
  'Bombycillidae': ['forestier'],
  'Oriolidae': ['forestier'],
  'Prunellidae': ['forestier', 'montagne'],
  'Muscicapidae': ['forestier', 'rocher', 'bocage'],  // gobemouches, rouges-queues, monticoles, traquets
  'Turdidae': ['forestier', 'urbain'],
  'Troglodytidae': ['forestier', 'urbain'],
  'Trogonidae': ['forestier'],
  'Coliidae': ['forestier'],
  'Nucifragidae': ['forestier', 'montagne'],
  'Vireonidae': ['forestier'],
  'Parulidae': ['forestier'],
  'Cardinalidae': ['forestier', 'urbain'],
  'Leiothrichidae': ['forestier'],
  'Pycnonotidae': ['forestier', 'urbain'],
  'Nectariniidae': ['forestier'],
  'Zosteropidae': ['forestier', 'urbain'],
  'Ramphastidae': ['forestier'],
  'Trochilidae': ['forestier'],
  'Cacatuidae': ['forestier'],
  'Casuariidae': ['forestier'],
  'Podargidae': ['forestier'],
  'Caprimulgidae': ['forestier', 'steppe'],

  // ── Rapaces diurnes (mixte forestier/bocage/montagne) ───────────────
  'Accipitridae': ['forestier', 'bocage', 'montagne'],
  'Falconidae': ['bocage', 'rocher', 'littoral'],
  'Cathartidae': ['montagne'],
  'Tytonidae': ['bocage', 'urbain'],

  // ── Montagne / rocher (peu de familles exclusives) ──────────────────
  'Tichodromidae': ['rocher', 'montagne'],

  // ── Steppe / plaines arides / grands terrains ouverts ───────────────
  'Alaudidae': ['steppe'],
  'Otididae': ['steppe'],
  'Pteroclidae': ['steppe'],
  'Burhinidae': ['steppe'],
  'Glareolidae': ['steppe', 'hzhumide'],
  'Cisticolidae': ['steppe'],
  'Turnicidae': ['steppe'],
  'Rheidae': ['steppe'],
  'Struthionidae': ['steppe'],
  'Phasianidae': ['bocage', 'forestier'],
  'Tetraonidae': ['forestier', 'montagne'],
  'Odontophoridae': ['bocage', 'forestier'],
  'Tinamidae': ['forestier', 'bocage'],
  'Numididae': ['steppe'],

  // ── Bocage / prairies / cultures (milieux mixtes ouverts semi-arborés)
  'Emberizidae': ['bocage', 'forestier'],
  'Passerellidae': ['bocage', 'forestier'],
  'Calcariidae': ['steppe', 'montagne'],
  'Motacillidae': ['bocage', 'hzhumide'],
  'Laniidae': ['bocage'],
  'Meropidae': ['bocage'],
  'Coraciidae': ['bocage', 'forestier'],
  'Upupidae': ['bocage'],
  'Corvidae': ['bocage', 'urbain', 'forestier', 'montagne'],
  'Sturnidae': ['bocage', 'urbain'],

  // ── Urbain (villes, parcs, bâtiments) ───────────────────────────────
  'Hirundinidae': ['urbain', 'bocage'],
  'Apodidae': ['urbain', 'rocher'],
  'Columbidae': ['urbain', 'forestier', 'bocage'],
  'Passeridae': ['urbain', 'bocage'],
  'Fringillidae': ['forestier', 'bocage', 'urbain'],
  'Icteridae': ['bocage', 'hzhumide'],
  'Estrildidae': ['bocage', 'urbain'],
  'Ploceidae': ['bocage'],
  'Psittacidae': ['urbain', 'forestier'],
  'Psittaculidae': ['urbain', 'forestier'],
};

// Charge liste
const eb = JSON.parse(readFileSync(join(__dir, 'rarity-data-ebird.json'), 'utf8'));
const sciNames = eb.map(r => r.sci).filter(Boolean);
console.log(`→ ${sciNames.length} espèces à classer.`);

// Fetch taxonomie eBird
console.log(`→ Téléchargement taxonomie eBird...`);
const url = 'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=en&cat=species';
const r = await fetch(url, { headers: { 'X-eBirdApiToken': EBIRD_KEY } });
if (!r.ok) throw new Error(`taxonomy HTTP ${r.status}`);
const tax = await r.json();
console.log(`  ${tax.length} espèces reçues.`);

const sciToFam = {};
for (const t of tax) if (t.sciName && t.familySciName) sciToFam[t.sciName.toLowerCase()] = t.familySciName;

const HABITATS = {};
const familyMisses = {};
let noFamCount = 0, mappedCount = 0;

for (const sci of sciNames) {
  const fam = sciToFam[sci];
  if (!fam) { noFamCount++; continue; }
  const cats = FAMILY_TO_CATS[fam];
  if (!cats) { familyMisses[fam] = (familyMisses[fam] || 0) + 1; continue; }
  HABITATS[sci] = [...cats];
  mappedCount++;
}

console.log(`\n→ ${mappedCount}/${sciNames.length} espèces mappées (${Math.round(100*mappedCount/sciNames.length)}%).`);
if (noFamCount) console.log(`  ${noFamCount} sans familySciName.`);

const topMisses = Object.entries(familyMisses).sort((a,b)=>b[1]-a[1]);
if (topMisses.length) {
  console.log(`\nFamilles absentes de FAMILY_TO_CATS :`);
  for (const [fam, n] of topMisses) console.log(`  ${fam}  (${n} espèces)`);
}

const CATS = ['forestier','hzhumide','eaudouce','pelagique','littoral','montagne','steppe','bocage','urbain','rocher'];
const catCounts = Object.fromEntries(CATS.map(c=>[c,0]));
for (const cats of Object.values(HABITATS)) for (const c of cats) if (catCounts[c] !== undefined) catCounts[c]++;
console.log(`\nDistribution :`);
for (const c of CATS) console.log(`  ${c.padEnd(10)} : ${catCounts[c]} espèces`);

const out = `// Généré par tools/build-habitats.mjs — Habitats par famille eBird (10 catégories).\n` +
            `// Ne pas éditer à la main. Regénérable : node tools/build-habitats.mjs\n` +
            `export const HABITATS = ${JSON.stringify(HABITATS, null, 0)};\n` +
            `export const HABITAT_CATS = ${JSON.stringify(CATS)};\n`;
writeFileSync(join(__dir, 'habitats.generated.js'), out);
writeFileSync(join(__dir, 'habitats-audit.json'), JSON.stringify({
  mappedCount, noFam: noFamCount, catCounts,
  missingFamilies: topMisses,
  sample: Object.entries(HABITATS).slice(0, 30).map(([k,v]) => `${k}: ${v.join(', ')}`)
}, null, 2));
console.log(`\n✓ Écrit tools/habitats.generated.js et tools/habitats-audit.json`);
