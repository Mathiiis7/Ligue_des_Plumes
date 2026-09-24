// Les 48 quinzaines eBird PAR ZONE (region / departement / etat), pour que l'histogramme
// de saisonnalite garde sa resolution quand une zone est selectionnee.
//
// POURQUOI
// freq_by_region.json ne stocke que 12 moyennes mensuelles par zone. L'histogramme les
// etirait sur ses creneaux, produisant des groupes de barres identiques : une resolution
// apparente de 48 pour une information de 12. Mesure sur les 27 863 series francaises
// (1 337 424 quinzaines) :
//   - 32,3 % des quinzaines s'ecartent d'au moins 1 point de la moyenne de leur mois
//   - 22,3 % d'au moins 2 points, 9,8 % d'au moins 5 points
//   - ecart relatif median : 49 % de la moyenne du mois
// Ce n'est pas du bruit, c'est de la phenologie : la Fauvette a tete noire passe de 7,2 %
// a 39,5 % a l'interieur du mois de mars en Bourgogne-Franche-Comte, le Rossignol de
// 5,7 % a 33,7 % dans avril. L'etirement affichait 21,5 % et 24,8 % partout.
//
// FORMAT, et pourquoi celui-la
// Trois leviers ont ramene la France de 4,43 Mo (48 nombres bruts) a 2,77 Mo :
//  1. Echelle RACINE : v -> round(sqrt(v) * 1295), deux caracteres en base 36. La
//     precision suit la valeur au lieu d'etre uniforme : 0,11 point vers 50 %, moins d'un
//     centieme de point pres du plancher eBird (0,0015), la ou une echelle lineaire
//     gaspillait des niveaux dans le haut que personne ne distingue sur un graphique.
//     Erreur maximale mesuree sur les 1,3 million de valeurs : 0,073 point.
//  2. Index d'especes par pays : les zones renvoient un numero en base 36 plutot que de
//     repeter "phylloscopus collybita" dans 109 fichiers.
//  3. Un fichier par zone : on ne telecharge que celle qu'on regarde, ~26 Ko.
//
// On ne filtre PAS les series "plates" : ne garder que celles qui s'ecartent de plus d'un
// point n'economisait que 0,56 Mo sur la France, au prix d'un chemin de repli de plus.
//
// SORTIE
//   data/countries/<cc>/freq48_index.json  = ["sci1","sci2",...]        (~12 Ko)
//   data/countries/<cc>/freq48/<ZONE>.json = {"<idx36>":"<96 car>"}     (~26 Ko)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR_BAR = join(RACINE, 'tools', 'ebird-barcharts-raw');
const DIR_DATA = join(RACINE, 'data', 'countries');

// Table nom francais -> cle scientifique, prise dans app.js : c'est elle qui fait foi dans
// l'appli, et les bar charts sont telecharges en locale fr_FR.
const LIGNES_APP = readFileSync(join(RACINE, 'app.js'), 'utf8').split(/\r?\n/);
// Certaines de ces tables tiennent sur une ligne (FR_NAMES, genere), d'autres sont
// ecrites a la main sur plusieurs (SCI_ALIAS) : on accumule jusqu'a equilibrer les
// accolades plutot que de supposer l'une ou l'autre forme.
const litConst = nom => {
  const i = LIGNES_APP.findIndex(x => x.startsWith(`const ${nom} = `));
  if(i < 0) throw new Error(`${nom} introuvable dans app.js`);
  let src = '', profondeur = 0, commence = false;
  for(let j = i; j < LIGNES_APP.length; j++){
    const l = LIGNES_APP[j];
    src += l + '\n';
    for(const ch of l.replace(/\/\/.*$/, '')){
      if(ch === '{' || ch === '['){ profondeur++; commence = true; }
      else if(ch === '}' || ch === ']') profondeur--;
    }
    if(commence && profondeur === 0) break;
  }
  return new Function(src + `; return ${nom};`)();
};
const FR_NAMES = litConst('FR_NAMES');
const SCI_ALIAS = litConst('SCI_ALIAS');
// Les deux sources ecrivent les memes oiseaux differemment : eBird sert "Heron
// garde-boeufs" et "Oedicneme criard" en digrammes la ou FR_NAMES porte les ligatures, et
// "Guignard d'Eurasie" avec une apostrophe typographique. Sans normalisation, quatre
// especes bien reelles (dont le Garrot a oeil d'or) perdaient silencieusement leur
// resolution dans une centaine de zones, ce que rien n'aurait signale.
const normNom = s => s
  .replace(/œ/g, 'oe').replace(/Œ/g, 'Oe')
  .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
  .replace(/[’ʼ]/g, "'")
  .replace(/\s+/g, ' ')
  .trim().toLowerCase();
const PAR_NOM = new Map();
for(const [sci, fr] of Object.entries(FR_NAMES)){
  const k = normNom(fr);
  if(!PAR_NOM.has(k)) PAR_NOM.set(k, sci);
}

const encode = v => Math.round(Math.sqrt(Math.max(0, Math.min(1, v))) * 1295)
  .toString(36).padStart(2, '0');

function lireBarchart(chemin){
  const out = [];
  for(const l of readFileSync(chemin, 'utf8').split(/\r?\n/)){
    if(!l || !l.includes('\t')) continue;
    if(/^(Sample Size|Frequency|Number of taxa)/i.test(l)) continue;
    const c = l.split('\t');
    const nom = c[0].trim();
    if(!nom) continue;
    const v = c.slice(1, 49).map(x => +x || 0);
    if(v.length === 48 && v.some(x => x > 0)) out.push({ nom, v });
  }
  return out;
}

const pays = readdirSync(DIR_DATA)
  .filter(cc => existsSync(join(DIR_DATA, cc, 'freq_by_region.json')))
  .sort();

let totalOctets = 0, totalZones = 0, totalSeries = 0;
const alertes = [];

for(const cc of pays){
  const dossier = join(DIR_DATA, cc);
  const freqRef = JSON.parse(readFileSync(join(dossier, 'freq_by_region.json'), 'utf8'));
  const zones = Object.keys(freqRef);
  // Un nom de bar chart peut ne pas figurer dans FR_NAMES (taxon nouveau, hybride,
  // "sp."). On ne retient que les especes que l'appli connait ET qui existent deja dans
  // freq_by_region pour cette zone : le fichier 48 est un raffinement de celui-la, pas
  // une source concurrente qui ferait apparaitre des especes ailleurs absentes.
  const index = [];
  const numero = new Map();
  const fichiers = new Map();
  let inconnues = 0, horsRef = 0, series = 0;

  for(const zone of zones){
    const chemin = join(DIR_BAR, `ebird-barchart-${zone}-2019-2026.txt`);
    if(!existsSync(chemin)) continue;
    const refZone = freqRef[zone] || {};
    const sortie = {};
    for(const { nom, v } of lireBarchart(chemin)){
      let sci = PAR_NOM.get(normNom(nom));
      if(!sci){ inconnues++; continue; }
      if(!(sci in refZone)){
        const alias = SCI_ALIAS[sci];
        if(alias && alias in refZone) sci = alias;
        else { horsRef++; continue; }
      }
      if(!numero.has(sci)){ numero.set(sci, index.length); index.push(sci); }
      sortie[numero.get(sci).toString(36)] = v.map(encode).join('');
      series++;
    }
    if(Object.keys(sortie).length) fichiers.set(zone, sortie);
  }

  if(!fichiers.size){ alertes.push(`${cc.toUpperCase()} : aucune zone exploitable`); continue; }

  const dirZones = join(dossier, 'freq48');
  if(existsSync(dirZones)) rmSync(dirZones, { recursive: true });
  mkdirSync(dirZones, { recursive: true });

  let octets = 0;
  for(const [zone, sortie] of fichiers){
    const s = JSON.stringify(sortie);
    writeFileSync(join(dirZones, `${zone}.json`), s);
    octets += s.length;
  }
  const sIndex = JSON.stringify(index);
  writeFileSync(join(dossier, 'freq48_index.json'), sIndex);
  octets += sIndex.length;

  totalOctets += octets; totalZones += fichiers.size; totalSeries += series;
  console.log(`${cc.toUpperCase()} : ${fichiers.size}/${zones.length} zones, ${series} series, `
    + `${(octets / 1048576).toFixed(2)} Mo (${Math.round(octets / fichiers.size / 1024)} Ko par zone)`
    + (inconnues ? `, ${inconnues} lignes hors FR_NAMES` : '')
    + (horsRef ? `, ${horsRef} hors freq_by_region` : ''));
}

console.log(`\n${totalSeries} series dans ${totalZones} zones, ${(totalOctets / 1048576).toFixed(2)} Mo au total.`);
console.log(`Moyenne par zone : ${Math.round(totalOctets / totalZones / 1024)} Ko — c'est le seul poids`
  + ` reellement telecharge, une zone a la fois.`);
if(alertes.length){ console.log('\nAlertes :'); for(const a of alertes) console.log('  - ' + a); }
