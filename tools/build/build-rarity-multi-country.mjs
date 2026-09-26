#!/usr/bin/env node
/*
  build-rarity-multi-country.mjs - Regenere tier + monthly bar chart pour ES/IT/GB/PT
  (les 4 pays sans bar chart pour le moment). Same logic que build-rarity-me-ebird.mjs
  mais parametrisee.

  Bar charts en francais (locale=fr_FR) : parseur identique a FR/ME.
  eBird taxonomy API : matche noms FR -> sciName.

  Sortie par pays :
    tools/real-rarity-{XX}-ebird.generated.js : { REAL_RARITY_{XX}_EBIRD, REAL_FREQ_MONTHLY_{XX} }

  Usage : node tools/build-rarity-multi-country.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

// Ajout du 2026-09-26 : toute l'Europe. Le Vatican, Monaco, Saint-Marin, le Liechtenstein
// et Andorre sont ecartes - de 46 a 178 especes chacun, pour des pays de 2 a 470 km2, ca
// ne fait pas un birdydex. Ecartes aussi les niveaux de zones trop fins pour etre lisibles,
// mais ca se regle dans REGIONS, pas ici : leur donnee nationale reste complete.
const COUNTRIES = ['FR', 'ES', 'IT', 'GB', 'PT', 'CH', 'NO', 'GR', 'IS', 'LK', 'NA', 'AU', 'NZ', 'US', 'CA',
  'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CY', 'CZ', 'DE', 'DK', 'EE', 'FI', 'FO', 'GG', 'GI',
  'HR', 'HU', 'IE', 'IM', 'JE', 'LT', 'LU', 'LV', 'MD', 'MK', 'MT', 'NL', 'PL', 'RO', 'RS',
  'RU', 'SE', 'SI', 'SJ', 'SK', 'UA', 'XK'];

// La France est passee sur ce generateur le 2026-09-23. Elle dependait jusque-la de
// build-rarity-ebird.mjs, devenu obsolete : il lisait FR_NAMES depuis index.html (la table
// vit dans app.js depuis le decoupage), appariait les anciens noms nord-americains contre un
// bar chart europeen, et plafonnait a 9 tiers avec des seuils qui lui etaient propres
// (0,35 / 0,20 / 0,10...). Les tiers francais avaient ete recalibres depuis sur l'echelle
// commune a 10 tiers, mais par un chemin qui n'etait plus celui du script.
//
// Trois particularites francaises, d'ou les tables ci-dessous :
//   - l'app nomme ses tables REAL_RARITY et REAL_FREQ_MONTHLY, sans suffixe de pays ;
//   - les bar charts regionaux FR couvrent 2015-2026 la ou tout le reste est sur 2019-2026 ;
//   - REAL_RARITY porte 8 anciennes cles de genre (bubulcus ibis, accipiter gentilis...),
//     doublons redondants de leur cle canonique : SCI_ALIAS les resout toutes. Elles sont
//     conservees par fusion a l'injection par prudence, pas par necessite.
const NOMS_TABLES = {
  FR: { rarete: 'REAL_RARITY', mensuel: 'REAL_FREQ_MONTHLY' },
};
const nomRarete = cc => (NOMS_TABLES[cc] && NOMS_TABLES[cc].rarete) || ('REAL_RARITY_' + cc + '_EBIRD');
const nomMensuel = cc => (NOMS_TABLES[cc] && NOMS_TABLES[cc].mensuel) || ('REAL_FREQ_MONTHLY_' + cc);

// Fenetre des bar charts regionaux, quand elle differe du national.
const FENETRE_REGIONS = { FR: '2015-2026' };
const fenetreRegion = cc => FENETRE_REGIONS[cc] || '2019-2026';

// Regions par pays (admin1 eBird). Ajoute la data monthly par region -> alimente
// data/freq_by_region_XX.json pour lazy-load runtime (comme FR).
const REGIONS = {
  // --- Europe, ajoutee le 2026-09-26 ---
  DE: ['DE-BW','DE-BY','DE-BE','DE-BB','DE-HB','DE-HH','DE-HE','DE-MV',
       'DE-NI','DE-NW','DE-RP','DE-SL','DE-SN','DE-ST','DE-SH','DE-TH'],
  NL: ['NL-DR','NL-FL','NL-FR','NL-GE','NL-GR','NL-LI','NL-NB','NL-NH',
       'NL-OV','NL-UT','NL-ZE','NL-ZH'],
  PL: ['PL-DS','PL-KP','PL-LU','PL-LB','PL-MZ','PL-MA','PL-OP','PL-PK',
       'PL-PD','PL-PM','PL-WN','PL-WP','PL-ZP','PL-LD','PL-SL','PL-SK'],
  CZ: ['CZ-PR','CZ-JM','CZ-JC','CZ-KA','CZ-VY','CZ-KR','CZ-LI','CZ-MO',
       'CZ-OL','CZ-PA','CZ-PL','CZ-ST','CZ-ZL','CZ-US'],
  SK: ['SK-BC','SK-BL','SK-KI','SK-NI','SK-PV','SK-TC','SK-TA','SK-ZI'],
  HU: ['HU-BA','HU-BZ','HU-BU','HU-BK','HU-BE','HU-BC','HU-CS','HU-DE',
       'HU-DU','HU-EG','HU-FE','HU-GY','HU-GS','HU-HB','HU-HE','HU-HV',
       'HU-JN','HU-KV','HU-KM','HU-KE','HU-MI','HU-NK','HU-NY','HU-NO',
       'HU-PE','HU-PS','HU-ST','HU-SO','HU-SN','HU-SZ','HU-SD','HU-SS',
       'HU-SK','HU-SH','HU-SF','HU-TB','HU-TO','HU-VA','HU-VE','HU-VM',
       'HU-ZA','HU-ZE'],
  RO: ['RO-AB','RO-AR','RO-AG','RO-BC','RO-BH','RO-BN','RO-BT','RO-BR',
       'RO-BV','RO-B','RO-BZ','RO-CL','RO-CS','RO-CJ','RO-CT','RO-CV',
       'RO-DJ','RO-DB','RO-GL','RO-GR','RO-GJ','RO-HR','RO-HD','RO-IL',
       'RO-IS','RO-IF','RO-MM','RO-MH','RO-MS','RO-NT','RO-OT','RO-PH',
       'RO-SJ','RO-SM','RO-SB','RO-SV','RO-TR','RO-TM','RO-TL','RO-VS',
       'RO-VN','RO-VL'],
  BG: ['BG-01','BG-02','BG-08','BG-07','BG-26','BG-09','BG-10','BG-11',
       'BG-12','BG-13','BG-14','BG-15','BG-16','BG-17','BG-18','BG-27',
       'BG-19','BG-20','BG-21','BG-23','BG-22','BG-24','BG-25','BG-03',
       'BG-04','BG-05','BG-06','BG-28'],
  HR: ['HR-07','HR-12','HR-19','HR-21','HR-18','HR-04','HR-06','HR-02',
       'HR-09','HR-20','HR-14','HR-11','HR-08','HR-03','HR-17','HR-05',
       'HR-10','HR-16','HR-13','HR-01','HR-15'],
  RS: ['RS-00','RS-14','RS-11','RS-23','RS-09','RS-08','RS-17','RS-20',
       'RS-24','RS-22','RS-10','RS-13','RS-19','RS-18','RS-21','RS-VO',
       'RS-15','RS-16','RS-12'],
  BA: ['BA-BIH','BA-SRP'],
  AL: ['AL-01','AL-09','AL-02','AL-03','AL-04','AL-05','AL-06','AL-07',
       'AL-08','AL-10','AL-11','AL-12'],
  SE: ['SE-K','SE-W','SE-I','SE-X','SE-N','SE-Z','SE-F','SE-H',
       'SE-G','SE-BD','SE-M','SE-AB','SE-D','SE-C','SE-S','SE-AC',
       'SE-Y','SE-U','SE-O','SE-T','SE-E'],
  FI: ['FI-08','FI-07','FI-05','FI-09','FI-10','FI-13','FI-14','FI-15',
       'FI-12','FI-11','FI-16','FI-17','FI-02','FI-03','FI-04','FI-19',
       'FI-06','FI-18','FI-01'],
  EE: ['EE-37','EE-39','EE-44','EE-51','EE-49','EE-59','EE-57','EE-67',
       'EE-65','EE-70','EE-74','EE-78','EE-82','EE-84','EE-86'],
  LT: ['LT-AL','LT-KU','LT-KL','LT-MR','LT-PN','LT-TA','LT-TE','LT-UT',
       'LT-VL','LT-SA'],
  BY: ['BY-BR','BY-HO','BY-HR','BY-MA','BY-MI','BY-VI'],
  UA: ['UA-71','UA-74','UA-77','UA-12','UA-14','UA-26','UA-63','UA-65',
       'UA-68','UA-35','UA-30','UA-32','UA-46','UA-09','UA-48','UA-51',
       'UA-53','UA-43','UA-56','UA-40','UA-59','UA-61','UA-05','UA-07',
       'UA-21','UA-23','UA-18'],
  RU: ['RU-AD','RU-ALT','RU-AL','RU-AMU','RU-ARK','RU-AST','RU-BA','RU-BEL',
       'RU-BRY','RU-BU','RU-CE','RU-CHE','RU-CHU','RU-CU','RU-DA','RU-IN',
       'RU-IRK','RU-IVA','RU-YEV','RU-KB','RU-KGD','RU-KL','RU-KLU','RU-KAM',
       'RU-KC','RU-KEM','RU-KHA','RU-KK','RU-KHM','RU-KIR','RU-KO','RU-KOS',
       'RU-KDA','RU-KYA','RU-KGN','RU-KRS','RU-LEN','RU-LIP','RU-MAG','RU-ME',
       'RU-MO','RU-MOW','RU-MOS','RU-MUR','RU-NEN','RU-NIZ','RU-SE','RU-NGR',
       'RU-NVS','RU-OMS','RU-ORE','RU-ORL','RU-PNZ','RU-PER','RU-PRI','RU-PSK',
       'RU-KR','RU-ROS','RU-RYA','RU-SPE','RU-SA','RU-SAK','RU-SAM','RU-SAR',
       'RU-SMO','RU-STA','RU-SVE','RU-TAM','RU-TA','RU-TOM','RU-TUL','RU-TY',
       'RU-TVE','RU-TYU','RU-UD','RU-ULY','RU-VLA','RU-VGG','RU-VLG','RU-VOR',
       'RU-YAN','RU-YAR','RU-CHI'],
  AT: ['AT-1','AT-2','AT-3','AT-4','AT-5','AT-6','AT-7','AT-8',
       'AT-9'],
  IE: ['IE-C','IE-L','IE-M','IE-U'],
  CY: ['CY-01','CY-02','CY-03','CY-04','CY-05','CY-06'],
  DK: ['DK-01','DK-02','DK-03','DK-04','DK-05','DK-06','DK-07','DK-08','DK-09','DK-10','DK-11','DK-12','DK-13'],
  BE: ['BE-BRU','BE-VLG','BE-WAL'],
// La France est volontairement absente de cette table. Son data/countries/fr/
// freq_by_region.json contient 109 zones — les 13 regions ET les 96 departements — pour
// 29 298 series, alors que seuls les bar charts des 13 regions existent en local.
// Regenerer depuis ici ecraserait le fichier avec 13 zones et 4 780 series, faisant
// disparaitre toutes les cartes departementales. Le national FR est bien produit ici,
// le regional reste sur sa source d origine.
  GB: ['GB-ENG-BDF','GB-ENG-BRC','GB-ENG-BST','GB-ENG-BKM','GB-ENG-CAM','GB-ENG-CHS',
       'GB-ENG-CON','GB-ENG-CMA','GB-ENG-DBY','GB-ENG-DEV','GB-ENG-DOR','GB-ENG-DUR',
       'GB-ENG-ERY','GB-ENG-ESX','GB-ENG-ESS','GB-ENG-GLS','GB-ENG-HAL','GB-ENG-HAM',
       'GB-ENG-HEF','GB-ENG-HRT','GB-ENG-IOW','GB-ENG-KEN','GB-ENG-LAN','GB-ENG-LEC',
       'GB-ENG-LIN','GB-ENG-LND','GB-ENG-MAN','GB-ENG-KWL','GB-ENG-NFK','GB-ENG-NYK',
       'GB-ENG-NTH','GB-ENG-NBL','GB-ENG-NTT','GB-ENG-OXF','GB-ENG-RUT','GB-ENG-SHR',
       'GB-ENG-SOM','GB-ENG-BNS','GB-ENG-STS','GB-ENG-STT','GB-ENG-SFK','GB-ENG-SRY',
       'GB-ENG-GAT','GB-ENG-WAR','GB-ENG-SAW','GB-ENG-WSX','GB-ENG-WKF','GB-ENG-WIL',
       'GB-ENG-WOR','GB-SCT-ABE','GB-SCT-ABD','GB-SCT-ANS','GB-SCT-AGB','GB-SCT-CLK',
       'GB-SCT-DGY','GB-SCT-DND','GB-SCT-EAY','GB-SCT-EDU','GB-SCT-ELN','GB-SCT-EDH',
       'GB-SCT-ELS','GB-SCT-FAL','GB-SCT-FIF','GB-SCT-GLG','GB-SCT-HLD','GB-SCT-MLN',
       'GB-SCT-MRY','GB-SCT-NAY','GB-SCT-NLK','GB-SCT-ORK','GB-SCT-PKN','GB-SCT-RFW',
       'GB-SCT-SCB','GB-SCT-ZET','GB-SCT-SAY','GB-SCT-SLK','GB-SCT-STG','GB-SCT-WDU',
       'GB-SCT-WLN','GB-WLS-AGY','GB-WLS-BGW','GB-WLS-BGE','GB-WLS-CAY','GB-WLS-CRF',
       'GB-WLS-CMN','GB-WLS-CGN','GB-WLS-CWY','GB-WLS-DEN','GB-WLS-FLN','GB-WLS-GWN',
       'GB-WLS-MTY','GB-WLS-MON','GB-WLS-NTL','GB-WLS-NWP','GB-WLS-PEM','GB-WLS-POW',
       'GB-WLS-RCT','GB-WLS-SWA','GB-WLS-TOF','GB-WLS-VGL','GB-WLS-WRX','GB-NIR-ANT',
       'GB-NIR-ARM','GB-NIR-BFS','GB-NIR-DRY','GB-NIR-DOW','GB-NIR-FER','GB-NIR-NYM',
       'GB-NIR-OMH'],
  PT: ['PT-01', 'PT-02', 'PT-03', 'PT-04', 'PT-05', 'PT-06', 'PT-07',
       'PT-08', 'PT-09', 'PT-10', 'PT-11', 'PT-12', 'PT-13', 'PT-14',
       'PT-15', 'PT-16', 'PT-17', 'PT-18', 'PT-20', 'PT-30'],
  ES: ['ES-AN', 'ES-AR', 'ES-AS', 'ES-CB', 'ES-CE', 'ES-CL', 'ES-CM',
       'ES-CN', 'ES-CT', 'ES-EX', 'ES-GA', 'ES-IB', 'ES-MC', 'ES-MD',
       'ES-ML', 'ES-NC', 'ES-PV', 'ES-RI', 'ES-VC'],
  IT: ['IT-21', 'IT-23', 'IT-25', 'IT-32', 'IT-34', 'IT-36', 'IT-42',
       'IT-45', 'IT-52', 'IT-55', 'IT-57', 'IT-62', 'IT-65', 'IT-67',
       'IT-72', 'IT-75', 'IT-77', 'IT-78', 'IT-82', 'IT-88'],
  // Ajouts 2026-09-21 : CH/NO/GR/IS/LK/NA.
  // La Suisse est VOLONTAIREMENT absente : depuis le 2026-09-26 ses zones sont les 7
  // grandes regions de l OFS, pas les 26 cantons, et leurs frequences sont produites par
  // une agregation ponderee des cantons (tools/build/agreger-ch.mjs). Relancer ce build
  // avec la liste des cantons ici ecraserait ce travail - c est arrive une fois.
  NO: ['NO-01','NO-02','NO-03','NO-04','NO-05','NO-06','NO-07','NO-08',
       'NO-09','NO-10','NO-11','NO-12','NO-14','NO-15','NO-16','NO-17',
       'NO-18','NO-19','NO-20'],
  GR: ['GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I',
       'GR-J','GR-K','GR-L','GR-M'],
  IS: ['IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8'],
  LK: ['LK-11','LK-12','LK-13','LK-21','LK-22','LK-23','LK-31','LK-32',
       'LK-33','LK-41','LK-42','LK-43','LK-44','LK-45','LK-51','LK-52',
       'LK-53','LK-61','LK-62','LK-71','LK-72','LK-81','LK-82','LK-91',
       'LK-92'],
  NA: ['NA-CA','NA-ER','NA-HA','NA-KA','NA-KH','NA-KU','NA-OD','NA-OH',
       'NA-OK','NA-ON','NA-OS','NA-OT','NA-OW'],
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  NZ: ['NZ-AUK','NZ-BOP','NZ-CAN','NZ-CI','NZ-GIS','NZ-HKB','NZ-MWT','NZ-MBH',
       'NZ-NSN','NZ-NTL','NZ-OTA','NZ-STL','NZ-TKI','NZ-TAS','NZ-WKO','NZ-WGN',
       'NZ-WTC'],
  US: ['US-AL','US-AK','US-AZ','US-AR','US-CA','US-CO','US-CT','US-DE','US-DC',
       'US-FL','US-GA','US-HI','US-ID','US-IL','US-IN','US-IA','US-KS','US-KY',
       'US-LA','US-ME','US-MD','US-MA','US-MI','US-MN','US-MS','US-MO','US-MT',
       'US-NE','US-NV','US-NH','US-NJ','US-NM','US-NY','US-NC','US-ND','US-OH',
       'US-OK','US-OR','US-PA','US-RI','US-SC','US-SD','US-TN','US-TX','US-UT',
       'US-VT','US-VA','US-WA','US-WV','US-WI','US-WY'],
  CA: ['CA-AB','CA-BC','CA-MB','CA-NB','CA-NL','CA-NT','CA-NS','CA-NU','CA-ON',
       'CA-PE','CA-QC','CA-SK','CA-YT'],
};

// Memes seuils que FR/ME (Option 1 recalibree 2026-08-27, tier 10 seuil 0.00015)
// MESURE DE LA RARETE : part des listes eBird du pays qui mentionnent l espece, sur
// 2019-2026. Autrement dit, la chance de la rencontrer lors d une sortie prise au hasard.
//
// Mesure exacte, sans parametre libre. Elle remplace trois formules qui tentaient de
// l approcher : le pic seul, le melange pic+moyenne, puis la moyenne quadratique. Chacune
// arbitrait la place a donner a la saison ; celle-ci n arbitre rien.
//
// Deux corrections viennent avec elle :
//   - on travaille sur les 48 quinzaines, plus sur 12 mois agreges par un MAX. Ce max etait
//     un pic deguise : il gonflait les valeurs de 57,8 % en moyenne, jusqu a +28 % pour les
//     especes saisonnieres comme le Rossignol philomele.
//   - on pondere par la taille d echantillon de chaque quinzaine, que le TSV fournit et
//     qu on ignorait. L effort varie d un facteur 2,9 sur l annee en France : 16 000 listes
//     en novembre contre 47 000 en mai.
//
// On prenait le seul pic, ce qui recompensait la saisonnalite : le Rossignol philomele,
// present six mois, ressortait tier 1 sur son pic de mai, devant le Pigeon biset present
// toute l annee a 18 %. Le tier disait "si je viens au bon moment" plutot que "quelle
// chance j ai de le rencontrer".
//
// La moyenne seule corrigeait trop : elle retrogradait le Martinet noir et l Hirondelle
// rustique au tier 2, alors qu ils sont omnipresents et voyants la moitie de l annee.
// La moyenne des deux garde ces migrateurs abondants au tier 1 et ne deplace que 42 taxons
// francais, contre 183 pour la moyenne seule.
//
// Noter l asymetrie que ca corrige : dans l ESPACE le tier national etait deja une moyenne,
// il diluait la Sittelle corse (tier 7 national, tier 1 en Corse-du-Sud) sur toute la France.
// Dans le TEMPS il prenait le pic. Les deux dimensions etaient traitees a l oppose.
//
// Seuils lisibles comme une difficulte : chacun est une chance de rencontre par sortie.
//   tier 1  >= 30 %    soit 1 sortie sur 3
//   tier 2  >= 10 %    1 sur 10
//   tier 3  >= 5 %     1 sur 20
//   tier 4  >= 2 %     1 sur 50
//   tier 5  >= 1 %     1 sur 100
//   tier 6  >= 0,6 %   1 sur 170
//   tier 7  >= 0,2 %   1 sur 500
//   tier 8  >= 0,05 %  1 sur 2 000
//   tier 9  >= 0,01 %  1 sur 10 000
//   tier 10 en dessous
//
// Calibres sur le catalogue NETTOYE des accidentelles (cf. _estReguliere) : 7 659 couples
// espece-pays, 480 especes en France. Les seuils precedents avaient ete cales sur un
// catalogue qui contenait encore 122 accidentels, et ils s effondraient une fois ceux-ci
// partis : 195 des 480 especes francaises tombaient en tier 7, les tiers 8 a 10 restant
// quasi vides. La repartition francaise est desormais 9 · 36 · 28 · 66 · 43 · 21 · 73 · 76
// · 92 · 36.
//
// Borne du tier 1 descendue de 30 % a 20 % le 2026-09-24 : a 30 %, le tier 2 couvrait un
// rapport de 3 (10 % a 30 %), le plus large du haut de l echelle. A 20 % il couvre un
// rapport de 2, comme les tiers 3 et 5. 165 couples espece-pays montent en tier 1, qui en
// compte 286 au lieu de 121 ; en France, 20 especes au lieu de 9.
// Le tier 6 est a 0,6 % et non 0,5 % : a 0,5 % le Gypaete barbu (0,527 %) ressortait
// "Assez rare", alors qu il faut monter en montagne pour le chercher. Seul seuil non rond
// de l echelle, assume.
const THRESHOLDS = [
  [0.24, 1], [0.12, 2], [0.06, 3], [0.03, 4],
  [0.015, 5], [0.0075, 6], [0.002, 7], [0.0005, 8],
  [0.0001, 9],
];
function weightFor(v){ for(const [min, w] of THRESHOLDS) if(v >= min) return w; return 10; }
// Moyenne ponderee par l effort : somme(frequence x nb de listes) / somme(nb de listes).
function valeurPonderee(valeurs, poids){
  let num = 0, den = 0;
  for(let i = 0; i < valeurs.length; i++){
    const n = poids[i] || 0;
    num += (valeurs[i] || 0) * n;
    den += n;
  }
  return den ? num / den : 0;
}
// Ligne "Sample Size" du bar chart : nombre de listes par quinzaine. Sans elle on ne peut
// ni ponderer ni agreger correctement, donc on refuse de deviner.
function lireEffort(lignes){
  const ligne = lignes.find(x => /sample size/i.test(x));
  if(!ligne) return null;
  const v = ligne.split(String.fromCharCode(9)).slice(1, 49).map(Number);
  return (v.length === 48 && v.every(x => !isNaN(x))) ? v : null;
}

const norm = s => s.toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]/g, '');

// Repli de nommage : nom du bar chart -> autre nom API possible.
//
// Ces alias datent de l'epoque ou la taxonomie etait interrogee en locale=fr, qui renvoie la
// nomenclature nord-americaine (Pluvier grand-gravelot, Grand Harle). Les bar charts europeens
// utilisent la nomenclature europeenne (Grand Gravelot, Harle bievre). Depuis le passage a
// locale=fr_FR l'API parle la meme langue que les bar charts : ces alias ne servent plus qu'en
// secours, essayes UNIQUEMENT si le nom brut ne matche pas. Les appliquer d'office faisait
// l'inverse du travail attendu et perdait silencieusement les especes concernees.
const BAR_CHART_ALIAS = {
  'Grand Gravelot': 'Pluvier grand-gravelot',
  'Petit Gravelot': 'Pluvier petit-gravelot',
  'Gravelot à collier interrompu': 'Pluvier à collier interrompu',
  'Gravelot semipalmé': 'Pluvier semipalmé',
  'Gravelot kildir': 'Pluvier kildir',
  'Gravelot de Leschenault': 'Pluvier de Leschenault',
  'Gravelot asiatique': 'Pluvier asiatique',
  'Guignard d’Eurasie': 'Pluvier guignard',
  'Guignard d\'Eurasie': 'Pluvier guignard',
  'Harle bièvre': 'Grand Harle',
};

function parseBarchart(path){
  const out = {};
  const lignes = readFileSync(path, 'utf8').split(/\r?\n/);
  const effort = lireEffort(lignes);
  if(!effort) throw new Error(`ligne "Sample Size" absente ou malformee : ${path}`);
  for(const ln of lignes){
    if(!ln.includes('\t')) continue;
    const p = ln.split('\t');
    const nm = p[0].trim();
    const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
    if(!nm || nums.length < 12 || /sample size/i.test(nm)) continue;
    const clean = nm.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    // 48 quinzaines -> 12 mois, chaque mois etant la moyenne de ses 4 quinzaines ponderee
    // par leur nombre de listes. Plus de max : c etait un pic deguise.
    const m12 = new Array(12).fill(0);
    for(let m = 0; m < 12; m++){
      m12[m] = valeurPonderee(nums.slice(m * 4, m * 4 + 4), effort.slice(m * 4, m * 4 + 4));
    }
    // La valeur annuelle se calcule sur les 48 quinzaines, pas sur les 12 mois agreges.
    out[norm(clean)] = { name: clean, freq: valeurPonderee(nums.slice(0, 48), effort), monthly: m12, q48: nums.slice(0, 48).map(v => +(v || 0).toFixed(5)) };
  }
  return out;
}

// Cache taxonomy eBird (partagee pour les 4 pays)
let TAXONOMY_CACHE = null;
async function fetchTaxonomy(){
  if(TAXONOMY_CACHE) return TAXONOMY_CACHE;
  console.log('Fetching eBird taxonomy (locale=fr_FR)...');
  const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species', {
    headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
  })).json();
  TAXONOMY_CACHE = {};   // norm(comName) -> sciName lowercase
  for(const t of tax) if(t.sciName && t.comName) TAXONOMY_CACHE[norm(t.comName)] = t.sciName.toLowerCase();
  console.log(`Taxonomy : ${tax.length} especes.`);
  return TAXONOMY_CACHE;
}

// Nom brut d'abord, alias en secours (voir BAR_CHART_ALIAS).
function resolveSci(tax, k, name){
  const direct = tax[k];
  if(direct) return direct;
  const al = BAR_CHART_ALIAS[name];
  return al ? tax[norm(al)] : undefined;
}

// Profil d effort mensuel par pays : part des listes de l annee tombant dans chaque mois.
// Le runtime en a besoin pour ponderer la valeur annuelle d une zone a partir de ses 12
// valeurs mensuelles, sans avoir a stocker les 48 quinzaines pour chacune des 109 zones.
const EFFORT_PAR_PAYS = {};

const BAR_DIR = join(__dir, '..', 'ebird-barcharts-raw');
const OUT_DIR = join(__dir, '..', '..', 'data', 'generated');

async function processCountry(cc){
  const barPath = join(BAR_DIR, `ebird-barchart-${cc}-2019-2026.txt`);
  const outPath = join(OUT_DIR, `real-rarity-${cc.toLowerCase()}-ebird.generated.js`);

  console.log(`\n=== ${cc} ===`);
  const bar = parseBarchart(barPath);
  {
    const eff = lireEffort(readFileSync(barPath, 'utf8').split(/\r?\n/));
    const parMois = [];
    for(let m = 0; m < 12; m++) parMois.push(eff[m*4] + eff[m*4+1] + eff[m*4+2] + eff[m*4+3]);
    const tot = parMois.reduce((a, b) => a + b, 0);
    EFFORT_PAR_PAYS[cc] = parMois.map(v => +(v / tot).toFixed(5));
  }
  console.log(`  Bar chart : ${Object.keys(bar).length} taxons`);

  const tax = await fetchTaxonomy();
  const rarity = {}, monthly = {};
  let matched = 0, unmatched = 0;
  const unmatchedList = [];
  for(const [k, { name, freq, monthly: m12 }] of Object.entries(bar)){
    const sci = resolveSci(tax, k, name);
    if(sci){
      rarity[sci] = weightFor(freq);
      monthly[sci] = m12.map(v => +v.toFixed(5));
      matched++;
    } else { unmatched++; unmatchedList.push(name); }
  }
  console.log(`  Matched : ${matched}, unmatched : ${unmatched}`);
  if(unmatchedList.length > 0){
    console.log(`  Sample unmatched : ${unmatchedList.slice(0, 5).join(', ')}${unmatchedList.length > 5 ? '...' : ''}`);
  }

  const distr = {1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0};
  for(const w of Object.values(rarity)) distr[w]++;
  console.log('  Distribution :', JSON.stringify(distr));

  const content = `// Genere par tools/build-rarity-multi-country.mjs depuis le bar chart eBird ${cc}.\n` +
                  `// Ne pas editer a la main.\n` +
                  `export const ${nomRarete(cc)} = ${JSON.stringify(rarity)};\n` +
                  `export const ${nomMensuel(cc)} = ${JSON.stringify(monthly)};\n`;
  writeFileSync(outPath, content);
  console.log(`  Ecrit : ${outPath} (${content.length} chars)`);

  // Regional : pour chaque region, parse le bar chart et extract les monthly par sci.
  // Alimente data/freq_by_region_XX.json (structure : { region: { sci: [12] } }).
  const regionalData = {};
  let nRegionsFound = 0;
  for (const regCode of REGIONS[cc] || []) {
    const barRegPath = join(BAR_DIR, `ebird-barchart-${regCode}-${fenetreRegion(cc)}.txt`);
    try {
      const barReg = parseBarchart(barRegPath);
      const regMap = {};
      for (const [k, { name, monthly: m12 }] of Object.entries(barReg)) {
        const sci = resolveSci(tax, k, name);
        if (sci) regMap[sci] = m12.map(v => +v.toFixed(5));
      }
      if (Object.keys(regMap).length > 0) {
        regionalData[regCode] = regMap;
        nRegionsFound++;
      }
    } catch (err) {
      console.warn(`  ! ${regCode} : ${err.message}`);
    }
  }
  const regJson = JSON.stringify(regionalData);
  // Path attendu par l'app : data/countries/xx/freq_by_region.json
  const countryDir = join(__dir, '..', '..', 'data', 'countries', cc.toLowerCase());
  const { mkdirSync } = await import('node:fs');
  mkdirSync(countryDir, { recursive: true });
  // Series en 48 quinzaines pour l histogramme de saisonnalite de la fiche espece. Il
  // etirait jusqu ici 12 valeurs mensuelles sur 52 creneaux, d ou des groupes de 4 barres
  // identiques : la resolution d eBird etait perdue a l affichage. Charge a la demande,
  // ces series pesent environ 200 Ko par pays et n ont pas leur place dans app.js.
  const q48 = {};
  for(const [k, o] of Object.entries(bar)){
    const sci = resolveSci(tax, k, o.name);
    if(sci && o.q48) q48[sci] = o.q48;
  }
  const q48Path = join(countryDir, `freq_48.json`);
  writeFileSync(q48Path, JSON.stringify(q48));
  console.log(`  Ecrit : ${q48Path} (${Object.keys(q48).length} especes)`);
  const regPath = join(countryDir, `freq_by_region.json`);
  // Garde-fou : ne jamais remplacer un fichier regional existant par un plus pauvre. Une
  // fenetre de TSV mal nommee ou une region non telechargee produirait sinon une perte
  // silencieuse — c est ce qui a failli effacer les 96 departements francais.
  const { existsSync } = await import('node:fs');
  let ancienNb = 0;
  if (existsSync(regPath)) {
    try { ancienNb = Object.keys(JSON.parse(readFileSync(regPath, 'utf8'))).length; } catch (e) {}
  }
  if (nRegionsFound < ancienNb) {
    console.warn(`  ! ${regPath} conserve : ${ancienNb} zones deja presentes contre ${nRegionsFound} produites.`);
  } else {
    writeFileSync(regPath, regJson);
    console.log(`  Ecrit : ${regPath} (${regJson.length} chars, ${nRegionsFound} regions)`);
  }
}

for(const cc of COUNTRIES){
  await processCountry(cc);
}
console.log('\nTermine.');


// Profil d effort mensuel, injecte dans app.js par inject-rarity-multi-country.mjs.
writeFileSync(join(OUT_DIR, 'effort-mensuel.generated.js'),
  `// Genere par tools/build/build-rarity-multi-country.mjs. Ne pas editer a la main.
` +
  `// Part des listes eBird de l annee tombant dans chaque mois, par pays.
` +
  `export const EFFORT_MENSUEL_PAR_PAYS = ${JSON.stringify(EFFORT_PAR_PAYS)};
`);
console.log(`
Profil d effort ecrit pour ${Object.keys(EFFORT_PAR_PAYS).length} pays.`);