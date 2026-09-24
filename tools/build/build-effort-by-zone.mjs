// Profil d'effort d'observation PAR ZONE (region / departement / etat), calcule depuis la
// ligne "Sample Size" que chaque bar chart eBird contient deja. Aucun scraping.
//
// POURQUOI
// La valeur annuelle d'une espece dans une zone est une moyenne de ses 12 frequences
// mensuelles ponderee par l'effort : sans ponderation, un mois a 3 listes pese autant
// qu'un mois a 300. Jusqu'ici toutes les zones d'un pays empruntaient le profil NATIONAL,
// alors que la France, elle, utilisait bien le sien. Mesure sur les 95 departements
// francais (26 646 couples zone-espece) :
//   - divergence mediane entre profil local et profil national : 12,1 % (max 33,5 %)
//   - 13,45 % des couples changent de palier de rarete
//   - les transitions sont symetriques : c'est du bruit par zone, pas un biais global
// Cas type : le Finistere prospecte 4,5 fois plus en octobre que la moyenne nationale
// (migration), la Lozere 1,9 fois plus en mai.
//
// Effet secondaire recherche : la ponderation locale desamorce le petit echantillon. Dans
// le Cantal, l'Autour des palombes affichait 1,535 % (tier 5) parce qu'un mois de novembre
// a 3 listes, dont une avec l'espece, pesait 4,5 % au national contre 0,6 % en local. Sa
// vraie valeur est 0,216 % (tier 7). Le poids local corrige sans seuil arbitraire.
//
// SORTIE : data/countries/<cc>/effort_by_zone.json = { "FR-ARA-15": [12 parts], ... }
// Les parts somment a 1. Lu par app.js (_loadFreqDataForCountry) et passe a
// _valeurAnnuelleZone, qui retombe sur EFFORT_MENSUEL_PAR_PAYS si la zone est absente.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR_BAR = join(RACINE, 'tools', 'ebird-barcharts-raw');
const DIR_DATA = join(RACINE, 'data', 'countries');

// Un fichier de zone s'appelle ebird-barchart-<CODE ZONE>-<periode>.txt, ou le code zone
// est exactement la cle utilisee dans freq_by_region.json (FR-ARA, FR-PDL-49, US-CA...).
const RE_FICHIER = /^ebird-barchart-(.+)-(\d{4})-(\d{4})\.txt$/;

function profilMensuel(chemin){
  const lignes = readFileSync(chemin, 'utf8').split(/\r?\n/);
  const ligne = lignes.find(l => /^Sample Size/i.test(l));
  if(!ligne) return null;
  // 48 quinzaines ; la 49e colonne du TSV est vide et vaut 0, on ne la prend pas.
  const eff = ligne.split('\t').slice(1, 49).map(v => +v || 0);
  if(eff.length !== 48) return null;
  const total = eff.reduce((a, b) => a + b, 0);
  if(!total) return null;
  const parts = [];
  for(let m = 0; m < 12; m++){
    parts.push(eff.slice(m * 4, m * 4 + 4).reduce((a, b) => a + b, 0) / total);
  }
  return { parts: parts.map(v => +v.toFixed(5)), listes: Math.round(total) };
}

// On ne garde qu'un fichier par zone : la fenetre 2019-2026, celle des frequences.
// Certaines zones ont aussi un 2015-2026 qui trainait d'un scraping anterieur.
const parZone = new Map();
for(const f of readdirSync(DIR_BAR)){
  const m = RE_FICHIER.exec(f);
  if(!m) continue;
  const [, zone, debut, fin] = m;
  if(debut !== '2019' || fin !== '2026') continue;
  parZone.set(zone, f);
}

// Regroupe par pays, en ne retenant que les zones reellement presentes dans
// freq_by_region.json : ecrire un profil pour une zone que l'appli ne connait pas
// n'aurait aucun effet et gonflerait le fichier.
const parPays = new Map();
for(const [zone, fichier] of parZone){
  const cc = zone.slice(0, 2);
  if(zone.length === 2) continue;   // le pays lui-meme : deja dans EFFORT_MENSUEL_PAR_PAYS
  if(!parPays.has(cc)) parPays.set(cc, []);
  parPays.get(cc).push({ zone, fichier });
}

let totalEcrits = 0, totalZones = 0;
const alertes = [];

for(const [cc, zones] of [...parPays].sort()){
  const dossier = join(DIR_DATA, cc.toLowerCase());
  const cheminFreq = join(dossier, 'freq_by_region.json');
  if(!existsSync(cheminFreq)){
    alertes.push(`${cc} : pas de freq_by_region.json, ${zones.length} zone(s) ignoree(s)`);
    continue;
  }
  const connues = new Set(Object.keys(JSON.parse(readFileSync(cheminFreq, 'utf8'))));
  const sortie = {};
  let ignorees = 0, maigres = 0;
  for(const { zone, fichier } of zones.sort((a, b) => a.zone.localeCompare(b.zone))){
    if(!connues.has(zone)){ ignorees++; continue; }
    const p = profilMensuel(join(DIR_BAR, fichier));
    if(!p){ alertes.push(`${zone} : ligne "Sample Size" absente ou vide`); continue; }
    // Une zone trop peu couverte donne un profil lui-meme bruite : sous 200 listes sur
    // huit ans, le profil national reste le moindre mal, on n'ecrit rien et app.js
    // retombera dessus.
    if(p.listes < 200){ maigres++; continue; }
    sortie[zone] = p.parts;
  }
  const n = Object.keys(sortie).length;
  if(!n){
    alertes.push(`${cc} : aucun profil retenu`);
    continue;
  }
  writeFileSync(join(dossier, 'effort_by_zone.json'), JSON.stringify(sortie));
  totalEcrits++; totalZones += n;
  const couverture = (n / connues.size * 100).toFixed(0);
  console.log(`${cc} : ${n}/${connues.size} zones (${couverture} %)`
    + (ignorees ? `, ${ignorees} hors freq_by_region` : '')
    + (maigres ? `, ${maigres} sous 200 listes` : ''));
}

console.log(`\n${totalZones} profils ecrits dans ${totalEcrits} pays.`);
if(alertes.length){
  console.log('\nAlertes :');
  for(const a of alertes) console.log('  - ' + a);
}
