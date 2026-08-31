#!/usr/bin/env node
/*
  build-genus-family.mjs

  Fetch la taxonomie officielle eBird (Clements + Cornell) et genere le
  dictionnaire GENUS_FAMILY (genre latin → nom famille FR).

  Source : https://api.ebird.org/v2/ref/taxonomy/ebird
  Sortie : GENUS_FAMILY inline dans app.js remplace avec le nouveau contenu.

  Usage :
    node tools/build/build-genus-family.mjs
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const APP_JS = path.join(ROOT, 'app.js');
const EBIRD_KEY = 'dbflh4atmsom';

console.log('Fetch taxonomie eBird...');
const r = await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr', {
  headers: { 'X-eBirdApiToken': EBIRD_KEY }
});
if(!r.ok){ console.error('HTTP', r.status); process.exit(1); }
const taxa = await r.json();
console.log('  ' + taxa.length + ' entrees recues');

// Traduction familles anglais -> francais (mapping curatel etendu). eBird ne fournit
// pas familyComName en francais dans l'API, on retape a partir de familyComName EN.
const FAM_FR = {
  // Anatidae
  'Ducks, Geese, and Waterfowl': 'Canards, oies, cygnes',
  // Cracidae
  'Guans, Chachalacas, and Curassows': 'Hoccos, pénélopes',
  // Numididae
  'Guineafowl': 'Pintades',
  // Odontophoridae
  'New World Quail': 'Colins',
  // Phasianidae
  'Pheasants, Grouse, and Allies': 'Faisans, perdrix, cailles',
  // Podicipedidae
  'Grebes': 'Grèbes',
  // Phoenicopteridae
  'Flamingos': 'Flamants',
  // Columbidae
  'Pigeons and Doves': 'Pigeons, tourterelles',
  // Pteroclidae
  'Sandgrouse': 'Gangas',
  // Otididae
  'Bustards': 'Outardes',
  // Cuculidae
  'Cuckoos': 'Coucous',
  // Caprimulgidae
  'Nightjars and Allies': 'Engoulevents',
  // Apodidae
  'Swifts': 'Martinets',
  // Trochilidae
  'Hummingbirds': 'Colibris',
  // Rallidae
  'Rails, Gallinules, and Coots': 'Râles, foulques',
  // Gruidae
  'Cranes': 'Grues',
  // Burhinidae
  'Thick-knees': 'Œdicnèmes',
  // Recurvirostridae
  'Stilts and Avocets': 'Avocettes, échasses',
  // Haematopodidae
  'Oystercatchers': 'Huîtriers',
  // Charadriidae
  'Plovers and Lapwings': 'Pluviers, vanneaux',
  // Scolopacidae
  'Sandpipers and Allies': 'Bécasseaux, chevaliers',
  // Turnicidae
  'Buttonquail': 'Turnix',
  // Glareolidae (variantes)
  'Coursers and Pratincoles': 'Glaréoles',
  'Pratincoles and Coursers': 'Glaréoles',
  // Stercorariidae
  'Skuas and Jaegers': 'Labbes',
  // Alcidae
  'Auks, Murres, and Puffins': 'Pingouins, guillemots',
  // Laridae
  'Gulls, Terns, and Skimmers': 'Goélands, mouettes, sternes',
  // Phaethontidae
  'Tropicbirds': 'Phaétons',
  // Gaviidae
  'Loons': 'Plongeons',
  // Diomedeidae
  'Albatrosses': 'Albatros',
  // Hydrobatidae + Oceanitidae
  'Northern Storm-Petrels': 'Océanites',
  'Southern Storm-Petrels': 'Océanites',
  // Procellariidae
  'Shearwaters and Petrels': 'Puffins, pétrels',
  // Ciconiidae
  'Storks': 'Cigognes',
  // Fregatidae
  'Frigatebirds': 'Frégates',
  // Sulidae
  'Boobies and Gannets': 'Fous',
  // Anhingidae
  'Anhingas': 'Anhingas',
  // Phalacrocoracidae
  'Cormorants and Shags': 'Cormorans',
  // Pelecanidae
  'Pelicans': 'Pélicans',
  // Ardeidae
  'Herons, Egrets, and Bitterns': 'Hérons, aigrettes',
  // Threskiornithidae
  'Ibises and Spoonbills': 'Ibis, spatules',
  // Cathartidae
  'New World Vultures': 'Vautours du Nouveau Monde',
  // Pandionidae
  'Osprey': 'Balbuzard',
  // Accipitridae
  'Hawks, Eagles, and Kites': 'Rapaces (aigles, buses…)',
  // Tytonidae
  'Barn-Owls': 'Effraies',
  // Strigidae
  'Owls': 'Chouettes, hiboux',
  // Trogonidae
  'Trogons': 'Trogons',
  // Upupidae
  'Hoopoes': 'Huppes',
  // Bucerotidae
  'Hornbills': 'Calaos',
  // Coraciidae
  'Rollers': 'Rolliers',
  // Alcedinidae
  'Kingfishers': 'Martins-pêcheurs',
  // Meropidae
  'Bee-eaters': 'Guêpiers',
  // Ramphastidae
  'Toucans': 'Toucans',
  // Picidae
  'Woodpeckers': 'Pics',
  // Falconidae
  'Falcons and Caracaras': 'Faucons',
  // Cacatuidae
  'Cockatoos': 'Cacatoès',
  // Psittaculidae
  'Old World Parrots': 'Perruches',
  // Psittacidae (variantes)
  'African and New World Parrots': 'Perroquets',
  'New World and African Parrots': 'Perroquets',
  // Tityridae etc omitted for brevity, will fall to family name EN if not translated
  // Tyrannidae
  'Tyrant Flycatchers': 'Tyrans',
  // Vireonidae
  'Vireos, Shrike-Babblers, and Erpornis': 'Viréos',
  // Oriolidae
  'Old World Orioles': 'Loriots',
  // Laniidae
  'Shrikes': 'Pies-grièches',
  // Corvidae
  'Crows, Jays, and Magpies': 'Corvidés (corneilles, pies…)',
  // Bombycillidae
  'Waxwings': 'Jaseurs',
  // Paridae
  'Tits, Chickadees, and Titmice': 'Mésanges',
  // Remizidae
  'Penduline-Tits': 'Rémiz',
  // Panuridae
  'Bearded Reedling': 'Panure',
  // Alaudidae
  'Larks': 'Alouettes',
  // Cisticolidae
  'Cisticolas and Allies': 'Cisticoles',
  // Locustellidae
  'Grassbirds and Allies': 'Locustelles',
  // Acrocephalidae
  'Reed Warblers and Allies': 'Rousserolles',
  // Hirundinidae
  'Swallows': 'Hirondelles',
  // Pycnonotidae
  'Bulbuls': 'Bulbuls',
  // Phylloscopidae
  'Leaf Warblers': 'Pouillots',
  // Scotocercidae
  'Bush Warblers and Allies': 'Bouscarles',
  // Cettiidae (variante ancienne)
  'Cettia Bush Warblers': 'Bouscarles',
  // Aegithalidae
  'Long-tailed Tits': 'Mésanges à longue queue',
  // Sylviidae (multiple versions selon revisions eBird)
  'Sylviid Warblers, Parrotbills, and Allies': 'Fauvettes',
  'Sylviid Warblers and Allies': 'Fauvettes',
  // Zosteropidae
  'White-eyes, Yuhinas, and Allies': 'Zostérops',
  // Timaliidae
  'Tree-Babblers, Scimitar-Babblers, and Allies': 'Timaliidés',
  // Leiothrichidae
  'Laughingthrushes and Allies': 'Léiothrichidés',
  // Regulidae
  'Kinglets': 'Roitelets',
  // Tichodromidae
  'Wallcreeper': 'Tichodrome',
  // Sittidae
  'Nuthatches': 'Sittelles',
  // Certhiidae
  'Treecreepers': 'Grimpereaux',
  // Troglodytidae
  'Wrens': 'Troglodytes',
  // Cinclidae
  'Dippers': 'Cincles',
  // Sturnidae
  'Starlings': 'Étourneaux',
  // Turdidae
  'Thrushes and Allies': 'Grives, merles',
  // Muscicapidae
  'Old World Flycatchers': 'Gobemouches, rougegorges…',
  // Estrildidae
  'Waxbills and Allies': 'Estrildidés',
  // Ploceidae
  'Weavers and Allies': 'Tisserins',
  // Viduidae
  'Indigobirds': 'Combassous',
  // Passeridae
  'Old World Sparrows': 'Moineaux',
  // Motacillidae
  'Wagtails and Pipits': 'Bergeronnettes, pipits',
  // Prunellidae
  'Accentors': 'Accenteurs',
  // Fringillidae
  'Finches, Euphonias, and Allies': 'Pinsons, chardonnerets…',
  // Calcariidae
  'Longspurs and Snow Buntings': 'Bruants des neiges',
  // Emberizidae
  'Old World Buntings': 'Bruants',
  // Passerellidae
  'New World Sparrows': 'Passerellidés',
  // Parulidae
  'New World Warblers': 'Parulidés',
  // Icteridae
  'Troupials and Allies': 'Icteridés',
  // Cardinalidae
  'Cardinals and Allies': 'Cardinalidés',
  // Musophagidae
  'Turacos': 'Touracos',
};

// Genus -> family FR
const genusFamily = {};
let unknown = new Set();
for(const t of taxa){
  if(t.category !== 'species') continue;      // skip subspecies, groups, etc.
  const sciName = t.sciName || '';
  const genus = sciName.split(' ')[0].toLowerCase();
  if(!genus) continue;
  const famEn = t.familyComName || t.familySciName;
  const famFr = FAM_FR[famEn] || famEn;
  if(!FAM_FR[famEn] && famEn) unknown.add(famEn);
  if(!genusFamily[genus]) genusFamily[genus] = famFr;
}

// Compat vieux noms : Bubulcus ibis avant split -> Herons (Ardea maintenant)
if(!genusFamily.bubulcus) genusFamily.bubulcus = 'Hérons, aigrettes';
console.log('Genres uniques :', Object.keys(genusFamily).length);
if(unknown.size){
  console.log('Familles anglaises sans traduction FR (utilisera EN par defaut) :');
  [...unknown].sort().forEach(f => console.log('  ' + f));
}

// Remplace le dictionnaire dans app.js
const appContent = fs.readFileSync(APP_JS, 'utf-8');
const oldDict = appContent.match(/const GENUS_FAMILY = \{[\s\S]*?\};/);
if(!oldDict){ console.error('GENUS_FAMILY not found in app.js'); process.exit(1); }
const newDict = 'const GENUS_FAMILY = ' + JSON.stringify(genusFamily) + ';';
const updated = appContent.replace(oldDict[0], newDict);
fs.writeFileSync(APP_JS, updated);
console.log('\napp.js mis a jour : ' + Object.keys(genusFamily).length + ' genres.');
