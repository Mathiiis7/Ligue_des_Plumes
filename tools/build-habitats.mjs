#!/usr/bin/env node
/*
  build-habitats.mjs — Habitats par espèce, basés sur la FAMILLE eBird.

  Pourquoi la famille et pas l'espèce : Wikidata P2974 est quasi-vide pour les
  oiseaux (1% de couverture), IUCN Red List demande une clé et 1 jour d'attente.
  La famille donne 100% de couverture immédiatement, au prix d'une granularité
  plus grossière (tous les Accipitridae → "mixte", pas de distinction gypaète
  vs busard). On raffinera plus tard avec IUCN si besoin.

  6 catégories app :
    forestier   — forêts (feuillus, conifères, taïga, mangrove...)
    aquatique   — eau douce (rivière, lac, marais)
    littoral    — mer / côte / plage / pélagique
    montagnard  — alpin, falaise, tundra
    agricole    — prairie, pâture, steppe, savane, culture, garrigue
    urbain      — ville, parc, jardin, bâtiment

  Une famille peut appartenir à plusieurs catégories (rare : plutôt 1-2).

  ÉTAPES
    1. Fetch la taxonomie eBird → sciName → familySciName
    2. Applique le mapping FAMILY_TO_CATS à chaque espèce
    3. Écrit tools/habitats.generated.js

  Usage : node tools/build-habitats.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

// Clé API v2 publique dans index.html (dbflh4atmsom) — même clé utilisée par l'app.
const EBIRD_KEY = 'dbflh4atmsom';

// Familles (nom scientifique latin renvoyé par eBird) → catégories app.
// Basé sur connaissances ornitho standards européennes/paléarctiques.
// Une famille peut appartenir à plusieurs catégories (choix editoriel).
// Familles absentes de cette table → aucune catégorie assignée (fallback : hors-catégorie).
const FAMILY_TO_CATS = {
  // ── Aquatique (eau douce) ────────────────────────────────────────────
  'Anatidae': ['aquatique', 'littoral'],        // canards, oies, cygnes (souvent côtiers en hiver)
  'Ardeidae': ['aquatique'],                    // hérons, aigrettes, butors
  'Threskiornithidae': ['aquatique'],           // ibis, spatules
  'Ciconiidae': ['aquatique', 'agricole'],      // cigognes (nichent en villages aussi)
  'Podicipedidae': ['aquatique'],               // grèbes
  'Gaviidae': ['aquatique', 'littoral'],        // plongeons
  'Phoenicopteridae': ['aquatique', 'littoral'],// flamants
  'Rallidae': ['aquatique'],                    // râles, foulques, poules d'eau
  'Recurvirostridae': ['aquatique', 'littoral'],// avocettes, échasses
  'Charadriidae': ['aquatique', 'littoral', 'agricole'], // pluviers, vanneaux
  'Scolopacidae': ['aquatique', 'littoral'],    // bécasseaux, chevaliers, bécassines
  'Haematopodidae': ['littoral'],               // huîtriers
  'Burhinidae': ['agricole'],                   // œdicnèmes (steppique)
  'Glareolidae': ['aquatique', 'agricole'],     // glaréoles (steppes humides)
  'Jacanidae': ['aquatique'],                   // jacanas
  'Alcedinidae': ['aquatique'],                 // martins-pêcheurs
  'Cinclidae': ['aquatique', 'montagnard'],     // cincles (torrents de montagne)
  'Acrocephalidae': ['aquatique'],              // rousserolles, phragmites (roselières)
  'Locustellidae': ['aquatique', 'agricole'],   // locustelles
  'Panuridae': ['aquatique'],                   // mésange à moustaches (roselières)
  'Rostratulidae': ['aquatique'],
  'Anhingidae': ['aquatique'],
  'Pandionidae': ['aquatique', 'littoral'],     // balbuzard

  // ── Littoral / marin ─────────────────────────────────────────────────
  'Sulidae': ['littoral'],                      // fous
  'Phalacrocoracidae': ['littoral', 'aquatique'], // cormorans (aussi lacs)
  'Laridae': ['littoral', 'aquatique'],         // mouettes, goélands, sternes
  'Sternidae': ['littoral', 'aquatique'],
  'Alcidae': ['littoral'],                      // guillemots, pingouins, macareux
  'Procellariidae': ['littoral'],               // puffins, pétrels (pélagique)
  'Hydrobatidae': ['littoral'],                 // océanites (ancien nom)
  'Oceanitidae': ['littoral'],                  // océanites (nouveau)
  'Diomedeidae': ['littoral'],                  // albatros
  'Stercorariidae': ['littoral'],               // labbes
  'Pelecanidae': ['littoral', 'aquatique'],     // pélicans
  'Fregatidae': ['littoral'],                   // frégates
  'Phaethontidae': ['littoral'],                // phaétons

  // ── Forestier ────────────────────────────────────────────────────────
  'Picidae': ['forestier'],                     // pics
  'Paridae': ['forestier', 'urbain'],           // mésanges (aussi jardins)
  'Sittidae': ['forestier'],                    // sittelles
  'Certhiidae': ['forestier'],                  // grimpereaux
  'Regulidae': ['forestier'],                   // roitelets
  'Aegithalidae': ['forestier'],                // orites
  'Sylviidae': ['forestier', 'agricole'],       // fauvettes (Sylvia)
  'Phylloscopidae': ['forestier'],              // pouillots
  'Cettiidae': ['forestier', 'aquatique'],      // bouscarles
  'Strigidae': ['forestier', 'agricole'],       // chouettes/hiboux
  'Tytonidae': ['agricole', 'urbain'],          // effraies
  'Cuculidae': ['forestier', 'agricole'],       // coucous
  'Bombycillidae': ['forestier'],               // jaseurs
  'Oriolidae': ['forestier'],                   // loriots
  'Prunellidae': ['forestier', 'montagnard'],   // accenteurs (mouchet en jardin, alpin en mont.)
  'Muscicapidae': ['forestier', 'agricole'],    // gobemouches, rouges-queues, traquets
  'Turdidae': ['forestier', 'urbain'],          // grives, merles
  'Trogonidae': ['forestier'],
  'Coliidae': ['forestier'],
  'Nucifragidae': ['forestier', 'montagnard'],
  'Tichodromidae': ['montagnard'],              // tichodrome échelette (nom eBird)
  'Remizidae': ['aquatique'],                   // rémiz penduline (roselières)
  'Parulidae': ['forestier'],                   // parulines (warblers Nouveau Monde)
  'Cardinalidae': ['forestier', 'urbain'],      // cardinaux
  'Icteridae': ['agricole', 'aquatique'],       // carouges, orioles Nouveau Monde
  'Passerellidae': ['agricole', 'forestier'],   // bruants du Nouveau Monde
  'Cisticolidae': ['agricole'],                 // cisticoles
  'Leiothrichidae': ['forestier'],              // timaliidés (jouvenceau)
  'Pycnonotidae': ['forestier', 'urbain'],      // bulbuls
  'Numididae': ['agricole'],                    // pintades
  'Gruidae': ['aquatique', 'agricole'],         // grues
  'Vireonidae': ['forestier'],
  'Troglodytidae': ['forestier', 'urbain'],     // troglodytes

  // ── Rapaces (mixte forestier/agricole/montagnard) ───────────────────
  'Accipitridae': ['forestier', 'agricole', 'montagnard'], // aigles, buses, busards, milans
  'Falconidae': ['agricole', 'littoral', 'montagnard'],    // faucons (pèlerin sur falaises)
  'Cathartidae': ['montagnard'],                // vautours néotropicaux

  // ── Agricole / steppique / prairie ──────────────────────────────────
  'Alaudidae': ['agricole'],                    // alouettes
  'Emberizidae': ['agricole', 'forestier'],     // bruants
  'Calcariidae': ['agricole', 'montagnard'],    // bruants des neiges/lapon
  'Motacillidae': ['agricole', 'aquatique'],    // bergeronnettes, pipits
  'Otididae': ['agricole'],                     // outardes
  'Phasianidae': ['agricole', 'forestier'],     // perdrix, faisans, cailles
  'Tetraonidae': ['forestier', 'montagnard'],   // grand tétras, tétras lyre, lagopèdes
  'Pteroclidae': ['agricole'],                  // gangas
  'Meropidae': ['agricole'],                    // guêpiers
  'Coraciidae': ['agricole', 'forestier'],      // rolliers
  'Upupidae': ['agricole'],                     // huppes
  'Laniidae': ['agricole'],                     // pies-grièches
  'Corvidae': ['agricole', 'urbain', 'forestier', 'montagnard'], // corvidés (très mixtes)
  'Sturnidae': ['agricole', 'urbain'],          // étourneaux
  'Turnicidae': ['agricole'],
  'Podargidae': ['forestier'],
  'Caprimulgidae': ['forestier', 'agricole'],   // engoulevents

  // ── Urbain (villes, parcs, bâtiments) ───────────────────────────────
  'Hirundinidae': ['urbain', 'agricole'],       // hirondelles
  'Apodidae': ['urbain', 'littoral'],           // martinets
  'Columbidae': ['urbain', 'forestier', 'agricole'], // pigeons, tourterelles
  'Passeridae': ['urbain', 'agricole'],         // moineaux
  'Fringillidae': ['forestier', 'agricole', 'urbain'], // pinsons, chardonnerets

  // ── Divers / mixte ───────────────────────────────────────────────────
  'Estrildidae': ['agricole', 'urbain'],
  'Ploceidae': ['agricole'],
  'Nectariniidae': ['forestier'],
  'Zosteropidae': ['forestier', 'urbain'],
  'Psittacidae': ['urbain', 'forestier'],       // perruches
  'Psittaculidae': ['urbain', 'forestier'],
  'Cacatuidae': ['forestier'],
  'Ramphastidae': ['forestier'],
  'Trochilidae': ['forestier'],
  'Odontophoridae': ['agricole', 'forestier'],
  'Rheidae': ['agricole'],
  'Struthionidae': ['agricole'],
  'Casuariidae': ['forestier'],
  'Spheniscidae': ['littoral'],                 // manchots
  'Tinamidae': ['forestier', 'agricole'],
};

// Charge sci names
const eb = JSON.parse(readFileSync(join(__dir, 'rarity-data-ebird.json'), 'utf8'));
const sciNames = eb.map(r => r.sci).filter(Boolean);
console.log(`→ ${sciNames.length} espèces à classer.`);

// Fetch taxonomie eBird avec family info
console.log(`→ Téléchargement taxonomie eBird (~10k espèces)...`);
const url = 'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=en&cat=species';
const r = await fetch(url, { headers: { 'X-eBirdApiToken': EBIRD_KEY } });
if (!r.ok) throw new Error(`taxonomy HTTP ${r.status}`);
const tax = await r.json();
console.log(`  ${tax.length} espèces reçues.`);

// sci lowercase → familySciName
const sciToFam = {};
for (const t of tax) {
  if (t.sciName && t.familySciName) sciToFam[t.sciName.toLowerCase()] = t.familySciName;
}

// Applique le mapping
const HABITATS = {};
const familyMisses = {};  // famille sans mapping → nb espèces (pour audit)
const noFamCount = { count: 0 };
let mappedCount = 0;

for (const sci of sciNames) {
  const fam = sciToFam[sci];
  if (!fam) { noFamCount.count++; continue; }
  const cats = FAMILY_TO_CATS[fam];
  if (!cats) {
    familyMisses[fam] = (familyMisses[fam] || 0) + 1;
    continue;
  }
  HABITATS[sci] = [...cats];
  mappedCount++;
}

console.log(`\n→ ${mappedCount}/${sciNames.length} espèces mappées (${Math.round(100*mappedCount/sciNames.length)}%).`);
if (noFamCount.count) console.log(`  ${noFamCount.count} espèces sans familySciName dans la taxonomie eBird.`);

const topMisses = Object.entries(familyMisses).sort((a,b)=>b[1]-a[1]);
if (topMisses.length) {
  console.log(`\nFamilles absentes de FAMILY_TO_CATS (à ajouter si couverture insuffisante) :`);
  for (const [fam, n] of topMisses) console.log(`  ${fam}  (${n} espèces)`);
}

// Distribution
const catCounts = { forestier:0, aquatique:0, littoral:0, montagnard:0, agricole:0, urbain:0 };
for (const cats of Object.values(HABITATS)) for (const c of cats) if (catCounts[c] !== undefined) catCounts[c]++;
console.log(`\nDistribution (une espèce compte dans chaque cat où elle est classée) :`);
for (const [c, n] of Object.entries(catCounts)) console.log(`  ${c.padEnd(11)} : ${n} espèces`);

// Écriture
const out = `// Généré par tools/build-habitats.mjs — Habitats par famille eBird.\n` +
            `// Ne pas éditer à la main. Regénérable : node tools/build-habitats.mjs\n` +
            `export const HABITATS = ${JSON.stringify(HABITATS, null, 0)};\n` +
            `export const HABITAT_CATS = ${JSON.stringify(['forestier','aquatique','littoral','montagnard','agricole','urbain'])};\n`;
writeFileSync(join(__dir, 'habitats.generated.js'), out);
writeFileSync(join(__dir, 'habitats-audit.json'), JSON.stringify({
  mappedCount, noFam: noFamCount.count, catCounts,
  missingFamilies: topMisses,
  sample: Object.entries(HABITATS).slice(0, 30).map(([k,v]) => `${k}: ${v.join(', ')}`)
}, null, 2));
console.log(`\n✓ Écrit tools/habitats.generated.js et tools/habitats-audit.json`);
