#!/usr/bin/env node
/*
  simplify-regions-multi.mjs - Genere les contours SVG simplifies des regions eBird
  pour les 14 pays multi-country (hors FR qui a son propre script avec les codes INSEE).

  Source : Natural Earth admin-1 (domaine public), telecharge en local :
    curl -sL -o ne_admin1.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson

  Sortie : data/regions-<cc>-simplified.json, meme format que regions-fr-simplified.json :
    { viewBox: "0 0 1000 900", regions: { "XX-YY": { name, path } } }

  Usage :
    node tools/build/simplify-regions-multi.mjs <chemin-ne_admin1.geojson> [pays]
    node tools/build/simplify-regions-multi.mjs ne_admin1.geojson          # tous
    node tools/build/simplify-regions-multi.mjs ne_admin1.geojson US,CA    # subset
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', '..', 'data');

// ---------------------------------------------------------------------------
// Resolveurs : feature Natural Earth -> code eBird.
// La plupart des pays matchent directement sur iso_3166_2. 3 exceptions :
//   ES : NE fournit les provinces, eBird les communautes autonomes -> code_hasc
//   IT : NE fournit les provinces, eBird les regions -> nom de region
//   GB : NE fournit les comtes, eBird les 4 nations -> geonunit
// ---------------------------------------------------------------------------
const ES_HASC = {
  'ES.AN':'ES-AN','ES.AR':'ES-AR','ES.AS':'ES-AS','ES.CB':'ES-CB','ES.CE':'ES-CE',
  'ES.CL':'ES-CL','ES.CM':'ES-CM','ES.CN':'ES-CN','ES.CT':'ES-CT','ES.EX':'ES-EX',
  'ES.GA':'ES-GA','ES.MD':'ES-MD','ES.ML':'ES-ML','ES.PV':'ES-PV','ES.VC':'ES-VC',
  // Divergences entre le HASC de NE et le code ISO utilise par eBird
  'ES.PM':'ES-IB',   // Baleares
  'ES.MU':'ES-MC',   // Murcie
  'ES.NA':'ES-NC',   // Navarre
  'ES.LO':'ES-RI',   // La Rioja
};
const IT_REGION = {
  'Piemonte':'IT-21', "Valle d'Aosta":'IT-23', 'Lombardia':'IT-25',
  'Trentino-Alto Adige':'IT-32', 'Veneto':'IT-34', 'Friuli-Venezia Giulia':'IT-36',
  'Liguria':'IT-42', 'Emilia-Romagna':'IT-45', 'Toscana':'IT-52', 'Umbria':'IT-55',
  'Marche':'IT-57', 'Lazio':'IT-62', 'Abruzzo':'IT-65', 'Molise':'IT-67',
  'Campania':'IT-72', 'Apulia':'IT-75', 'Basilicata':'IT-77', 'Calabria':'IT-78',
  'Sicily':'IT-82', 'Sardegna':'IT-88',
};
const GB_UNIT = {
  'England':'GB-ENG', 'Scotland':'GB-SCT', 'Wales':'GB-WLS', 'Northern Ireland':'GB-NIR',
};
// Codes iso_3166_2 de NE qui different du code eBird
const ISO_FIXUP = {
  'GR-A1':'GR-I',     // Attique
  'NZ-CIT':'NZ-CI',   // Chatham Islands
  // Natural Earth nomme encore la Zabaikalie par son ancien nom, Tchita.
  'RU-ZAB':'RU-CHI',
};

// Vojvodine : eBird en fait une seule zone, Natural Earth la livre en 7 districts.
const RS_VOJVODINE = new Set(['RS-01','RS-02','RS-03','RS-04','RS-05','RS-06','RS-07']);
// Natural Earth etiquette DEUX polygones croates « HR-12 ». Mesure des centres :
// HRV-1602 est a 45,22N 17,81E (Brod-Posavina) et HRV-1604 a 45,41N 17,68E - c'est la
// Pozega-Slavonie, HR-11, que le fichier a mal nommee.
const HR_POZEGA = 'HRV-1604';


// Irlande : eBird utilise les 4 provinces historiques, Natural Earth les 34 comtes.
// Rattachement par nom de comte - aucune autre source ne porte la province.
const IE_PROVINCE = {
  'Galway':'IE-C','Leitrim':'IE-C','Mayo':'IE-C','Roscommon':'IE-C','Sligo':'IE-C',
  'Carlow':'IE-L','Dublin':'IE-L','Dún Laoghaire–Rathdown':'IE-L','Fingal':'IE-L',
  'South Dublin':'IE-L','Kildare':'IE-L','Kilkenny':'IE-L','Laoighis':'IE-L',
  'Longford':'IE-L','Louth':'IE-L','Meath':'IE-L','Offaly':'IE-L','Westmeath':'IE-L',
  'Wexford':'IE-L','Wicklow':'IE-L',
  'Clare':'IE-M','Cork':'IE-M','Kerry':'IE-M','Limerick':'IE-M','North Tipperary':'IE-M',
  'South Tipperary':'IE-M','Waterford':'IE-M',
  'Cavan':'IE-U','Donegal':'IE-U','Monaghan':'IE-U',
};
// Belgique : eBird a 3 regions, Natural Earth 11 provinces qui portent deja leur
// rattachement dans le champ 'region'.
const BE_REGION = { 'Flemish':'BE-VLG', 'Walloon':'BE-WAL', 'Capital Region':'BE-BRU' };


// Royaume-Uni : eBird descend au comte (109), Natural Earth va encore plus fin (232
// autorites unitaires et boroughs). Quatre chemins, essayes dans cet ordre :
//   1. le nom colle directement                        -> 100 contours
//   2. le champ 'region' nomme le comte ceremonial      -> Greater London, West Midlands...
//   3. 'region_cod' pour les comtes que NE eclate       -> Bedfordshire, Berkshire...
//   4. une poignee de cas nommes a la main
// Remplace l'ancien decoupage en 4 nations : une zone de 60 900 km2 ne dit rien d'utile
// a qui cherche ou aller voir un oiseau.
const GB_REGION_COD = {
  'GB.BD':'GB-ENG-BDF', 'GB.BK':'GB-ENG-BRC', 'GB.SY':'GB-ENG-BNS', 'GB.WY':'GB-ENG-WKF',
};
const GB_NOM_EXPLICITE = {
  // Cheshire ceremonial : NE le livre en quatre morceaux.
  'Cheshire West and Chester':'GB-ENG-CHS', 'Cheshire East':'GB-ENG-CHS',
  'Halton':'GB-ENG-CHS', 'Warrington':'GB-ENG-CHS',
  // Tyne and Wear, idem.
  'Newcastle upon Tyne':'GB-ENG-GAT', 'North Tyneside':'GB-ENG-GAT',
  'South Tyneside':'GB-ENG-GAT', 'Gateshead':'GB-ENG-GAT', 'Sunderland':'GB-ENG-GAT',
  // eBird dit « Orkney Islands », Natural Earth « Orkney ».
  'Orkney':'GB-SCT-ORK',
  // Coquille dans Natural Earth : il manque le r de Ayrshire.
  'North Ayshire':'GB-SCT-NAY',
};
// Les 33 boroughs londoniens portent chacun leur nom ; c'est leur champ 'region' qui dit
// Londres, et eBird n'en fait qu'une zone.
const GB_REGION_EXPLICITE = { 'Greater London':'GB-ENG-LND' };
const GB_PAR_NOM = new Map([["bedfordshire","GB-ENG-BDF"],["berkshire","GB-ENG-BRC"],["bristol","GB-ENG-BST"],["buckinghamshire","GB-ENG-BKM"],["cambridgeshire","GB-ENG-CAM"],["cheshire","GB-ENG-CHS"],["cornwall","GB-ENG-CON"],["cumbria","GB-ENG-CMA"],["derbyshire","GB-ENG-DBY"],["devon","GB-ENG-DEV"],["dorset","GB-ENG-DOR"],["durham","GB-ENG-DUR"],["east riding of yorkshire","GB-ENG-ERY"],["east sussex","GB-ENG-ESX"],["essex","GB-ENG-ESS"],["gloucestershire","GB-ENG-GLS"],["halton","GB-ENG-HAL"],["hampshire","GB-ENG-HAM"],["herefordshire","GB-ENG-HEF"],["hertfordshire","GB-ENG-HRT"],["isle of wight","GB-ENG-IOW"],["kent","GB-ENG-KEN"],["lancashire","GB-ENG-LAN"],["leicestershire","GB-ENG-LEC"],["lincolnshire","GB-ENG-LIN"],["london","GB-ENG-LND"],["manchester","GB-ENG-MAN"],["merseyside","GB-ENG-KWL"],["norfolk","GB-ENG-NFK"],["north yorkshire","GB-ENG-NYK"],["northamptonshire","GB-ENG-NTH"],["northumberland","GB-ENG-NBL"],["nottinghamshire","GB-ENG-NTT"],["oxfordshire","GB-ENG-OXF"],["rutland","GB-ENG-RUT"],["shropshire","GB-ENG-SHR"],["somerset","GB-ENG-SOM"],["south yorkshire","GB-ENG-BNS"],["staffordshire","GB-ENG-STS"],["stockton-on-tees","GB-ENG-STT"],["suffolk","GB-ENG-SFK"],["surrey","GB-ENG-SRY"],["tyne and wear","GB-ENG-GAT"],["warwickshire","GB-ENG-WAR"],["west midlands","GB-ENG-SAW"],["west sussex","GB-ENG-WSX"],["west yorkshire","GB-ENG-WKF"],["wiltshire","GB-ENG-WIL"],["worcestershire","GB-ENG-WOR"],["aberdeen","GB-SCT-ABE"],["aberdeenshire","GB-SCT-ABD"],["angus","GB-SCT-ANS"],["argyll and bute","GB-SCT-AGB"],["clackmannanshire","GB-SCT-CLK"],["dumfries and galloway","GB-SCT-DGY"],["dundee","GB-SCT-DND"],["east ayrshire","GB-SCT-EAY"],["east dunbartonshire","GB-SCT-EDU"],["east lothian","GB-SCT-ELN"],["edinburgh","GB-SCT-EDH"],["eilean siar","GB-SCT-ELS"],["falkirk","GB-SCT-FAL"],["fife","GB-SCT-FIF"],["glasgow","GB-SCT-GLG"],["highland","GB-SCT-HLD"],["midlothian","GB-SCT-MLN"],["moray","GB-SCT-MRY"],["north ayrshire","GB-SCT-NAY"],["north lanarkshire","GB-SCT-NLK"],["orkney islands","GB-SCT-ORK"],["perthshire and kinross","GB-SCT-PKN"],["renfrewshire","GB-SCT-RFW"],["scottish borders","GB-SCT-SCB"],["shetland islands","GB-SCT-ZET"],["south ayrshire","GB-SCT-SAY"],["south lanarkshire","GB-SCT-SLK"],["stirling","GB-SCT-STG"],["west dunbartonshire","GB-SCT-WDU"],["west lothian","GB-SCT-WLN"],["anglesey","GB-WLS-AGY"],["blaenau gwent","GB-WLS-BGW"],["bridgend","GB-WLS-BGE"],["caerphilly","GB-WLS-CAY"],["cardiff","GB-WLS-CRF"],["carmarthenshire","GB-WLS-CMN"],["ceredigion","GB-WLS-CGN"],["conwy","GB-WLS-CWY"],["denbighshire","GB-WLS-DEN"],["flintshire","GB-WLS-FLN"],["gwynedd","GB-WLS-GWN"],["merthyr tydfil","GB-WLS-MTY"],["monmouthshire","GB-WLS-MON"],["neath port talbot","GB-WLS-NTL"],["newport","GB-WLS-NWP"],["pembrokeshire","GB-WLS-PEM"],["powys","GB-WLS-POW"],["rhondda, cynon, taff","GB-WLS-RCT"],["swansea","GB-WLS-SWA"],["torfaen","GB-WLS-TOF"],["vale of glamorgan","GB-WLS-VGL"],["wrexham","GB-WLS-WRX"],["antrim","GB-NIR-ANT"],["armagh","GB-NIR-ARM"],["belfast","GB-NIR-BFS"],["derry","GB-NIR-DRY"],["down","GB-NIR-DOW"],["fermanagh","GB-NIR-FER"],["newry and mourne","GB-NIR-NYM"],["omagh","GB-NIR-OMH"]]);
function resolveGB(props){
  const n = (props.name || '').toLowerCase();
  if(GB_PAR_NOM.has(n)) return GB_PAR_NOM.get(n);
  const r = (props.region || '').toLowerCase();
  if(GB_PAR_NOM.has(r)) return GB_PAR_NOM.get(r);
  if(GB_REGION_EXPLICITE[props.region]) return GB_REGION_EXPLICITE[props.region];
  if(GB_REGION_COD[props.region_cod]) return GB_REGION_COD[props.region_cod];
  return GB_NOM_EXPLICITE[props.name] || null;
}

// Pays ou une region eBird agrege plusieurs features Natural Earth (-> dissolve requis).
const AGGREGATED = new Set(['ES', 'IT', 'GB', 'IE', 'BE', 'RS', 'SI', 'LV', 'CH', 'DK']);

function resolveCode(cc, props){
  if(cc === 'ES') return ES_HASC[props.code_hasc] || null;
  if(cc === 'IT') return IT_REGION[props.region] || null;
  if(cc === 'GB') return resolveGB(props);
  if(cc === 'IE') return IE_PROVINCE[props.name] || null;
  if(cc === 'BE') return BE_REGION[props.region] || null;
  if(cc === 'HR' && props.adm1_code === HR_POZEGA) return 'HR-11';
  if(cc === 'RS' && RS_VOJVODINE.has(props.iso_3166_2)) return 'RS-VO';
  const iso = props.iso_3166_2;
  if(!iso) return null;
  const fixed = ISO_FIXUP[iso] || iso;
  return fixed.startsWith(cc + '-') ? fixed : null;
}

// Noms FR des regions (repris de REGIONS_BY_COUNTRY dans app.js). Fallback sur le nom NE.
const NAMES = {
  'GB-ENG':'Angleterre','GB-SCT':'Écosse','GB-WLS':'Pays de Galles','GB-NIR':'Irlande du Nord',
  'ES-AN':'Andalousie','ES-AR':'Aragon','ES-AS':'Asturies','ES-CB':'Cantabrie','ES-CE':'Ceuta',
  'ES-CL':'Castille-et-León','ES-CM':'Castille-La Manche','ES-CN':'Îles Canaries','ES-CT':'Catalogne',
  'ES-EX':'Estrémadure','ES-GA':'Galice','ES-IB':'Îles Baléares','ES-MC':'Murcie','ES-MD':'Madrid',
  'ES-ML':'Melilla','ES-NC':'Navarre','ES-PV':'Pays basque','ES-RI':'La Rioja','ES-VC':'Valence',
  'IT-21':'Piémont','IT-23':"Val d'Aoste",'IT-25':'Lombardie','IT-32':'Trentin-Haut-Adige',
  'IT-34':'Vénétie','IT-36':'Frioul-Vénétie Julienne','IT-42':'Ligurie','IT-45':'Émilie-Romagne',
  'IT-52':'Toscane','IT-55':'Ombrie','IT-57':'Marches','IT-62':'Latium','IT-65':'Abruzzes',
  'IT-67':'Molise','IT-72':'Campanie','IT-75':'Pouilles','IT-77':'Basilicate','IT-78':'Calabre',
  'IT-82':'Sicile','IT-88':'Sardaigne',
  'GR-A':'Macédoine-Orientale-et-Thrace','GR-B':'Macédoine centrale','GR-C':'Macédoine-Occidentale',
  'GR-D':'Épire','GR-E':'Thessalie','GR-F':'Îles Ioniennes','GR-G':'Grèce-Occidentale',
  'GR-H':'Grèce centrale','GR-I':'Attique','GR-J':'Péloponnèse','GR-K':'Égée-Septentrionale',
  'GR-L':'Égée-Méridionale','GR-M':'Crète',
  'IS-1':'Reykjavík','IS-2':'Sud-Ouest','IS-3':'Ouest','IS-4':"Fjords de l'Ouest",
  'IS-5':'Nord-Ouest','IS-6':'Nord-Est','IS-7':'Est','IS-8':'Sud',
  'AU-ACT':'Territoire de la capitale','AU-NSW':'Nouvelle-Galles du Sud','AU-NT':'Territoire du Nord',
  'AU-QLD':'Queensland','AU-SA':'Australie-Méridionale','AU-TAS':'Tasmanie','AU-VIC':'Victoria',
  'AU-WA':'Australie-Occidentale',
  'NZ-CI':'Îles Chatham','NZ-WTC':'Côte Ouest',
  'US-CA':'Californie','US-GA':'Géorgie','US-HI':'Hawaï','US-LA':'Louisiane','US-NM':'Nouveau-Mexique',
  'US-NC':'Caroline du Nord','US-ND':'Dakota du Nord','US-SC':'Caroline du Sud','US-SD':'Dakota du Sud',
  'US-PA':'Pennsylvanie','US-FL':'Floride','US-DC':'District de Columbia',
  'CA-NB':'Nouveau-Brunswick','CA-NL':'Terre-Neuve-et-Labrador','CA-NT':'Territoires du Nord-Ouest',
  'CA-NS':'Nouvelle-Écosse','CA-PE':"Île-du-Prince-Édouard",'CA-QC':'Québec',
  'NA-CA':'Zambèze','NA-KA':'ǁKaras','NA-OK':'Kavango',
};

// Liste stricte des codes eBird par pays : tout ce qui n'y est pas est ignore.
// Indispensable, sinon Natural Earth apporte des territoires que eBird ne couvre pas
// (NO-21 Bouvet a -54 de latitude, GR-69 Mont Athos, IS-0, iles australiennes...)
// qui etirent la bbox et ecrasent le pays dans le viewBox.
const EBIRD_REGIONS = {
  // --- Europe, ajoutee le 2026-09-26 -------------------------------------------
  // Codes eBird (subnational1). Les contours viennent de iso_3166_2 dans Natural Earth,
  // qui s'y apparie de 93 a 100 % selon le pays - sauf Irlande, Belgique et Danemark,
  // traites plus bas. Malte, Macedoine du Nord, Luxembourg, Chypre et Moldavie n'ont
  // volontairement pas de zones : leur niveau 1 eBird est la commune, donc illisible.
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
  // Chypre : les 6 districts, Keryneia comprise. Contours geoBoundaries (OpenStreetMap,
  // ODbL) - Natural Earth ne fournit que les 5 du sud, arretes a la ligne verte.
  CY: ['CY-01','CY-02','CY-03','CY-04','CY-05','CY-06'],
  // Danemark : Natural Earth ne connait que les 5 regions modernes, soit PLUS grossier
  // que les 13 zones eBird - la fusion ne pouvait rien. Les contours viennent donc des
  // 98 communes de geoBoundaries (domaine public), regroupees par la zone parente que le
  // code eBird de niveau 2 donne lui-meme : DK-07-01 depend de DK-07.
  DK: ['DK-01','DK-02','DK-03','DK-04','DK-05','DK-06','DK-07','DK-08','DK-09','DK-10','DK-11','DK-12','DK-13'],
  // Slovenie et Lettonie : eBird descend a la commune (193 et 119), soit 104 et 546 km2
  // par zone. On regroupe dans leurs regions officielles, que Natural Earth porte deja
  // dans son champ region. Les frequences sont agregees en parallele, ponderees par le
  // nombre de listes de chaque commune - le bar chart le donne, donc c'est exact.
  SI: ['SI-R01','SI-R02','SI-R03','SI-R04','SI-R05','SI-R06','SI-R07','SI-R08','SI-R09','SI-R10','SI-R11','SI-R12'],
  LV: ['LV-R01','LV-R02','LV-R03','LV-R04','LV-R05'],
  BE: ['BE-BRU','BE-VLG','BE-WAL'],
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
  ES: ['ES-AN','ES-AR','ES-AS','ES-CB','ES-CE','ES-CL','ES-CM','ES-CN','ES-CT','ES-EX',
       'ES-GA','ES-IB','ES-MC','ES-MD','ES-ML','ES-NC','ES-PV','ES-RI','ES-VC'],
  IT: ['IT-21','IT-23','IT-25','IT-32','IT-34','IT-36','IT-42','IT-45','IT-52','IT-55',
       'IT-57','IT-62','IT-65','IT-67','IT-72','IT-75','IT-77','IT-78','IT-82','IT-88'],
  PT: ['PT-01','PT-02','PT-03','PT-04','PT-05','PT-06','PT-07','PT-08','PT-09','PT-10',
       'PT-11','PT-12','PT-13','PT-14','PT-15','PT-16','PT-17','PT-18','PT-20','PT-30'],
  // Suisse : les 7 grandes regions de l OFS, pas les 26 cantons.
  CH: ['CH-R1','CH-R2','CH-R3','CH-R4','CH-R5','CH-R6','CH-R7'],
  NO: ['NO-01','NO-02','NO-03','NO-04','NO-05','NO-06','NO-07','NO-08','NO-09','NO-10',
       'NO-11','NO-12','NO-14','NO-15','NO-16','NO-17','NO-18','NO-19','NO-20'],
  GR: ['GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I','GR-J','GR-K','GR-L','GR-M'],
  IS: ['IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8'],
  LK: ['LK-11','LK-12','LK-13','LK-21','LK-22','LK-23','LK-31','LK-32','LK-33','LK-41',
       'LK-42','LK-43','LK-44','LK-45','LK-51','LK-52','LK-53','LK-61','LK-62','LK-71',
       'LK-72','LK-81','LK-82','LK-91','LK-92'],
  NA: ['NA-CA','NA-ER','NA-HA','NA-KA','NA-KH','NA-KU','NA-OD','NA-OH','NA-OK','NA-ON',
       'NA-OS','NA-OT','NA-OW'],
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  NZ: ['NZ-AUK','NZ-BOP','NZ-CAN','NZ-CI','NZ-GIS','NZ-HKB','NZ-MWT','NZ-MBH','NZ-NSN',
       'NZ-NTL','NZ-OTA','NZ-STL','NZ-TKI','NZ-TAS','NZ-WKO','NZ-WGN','NZ-WTC'],
  US: ['US-AL','US-AK','US-AZ','US-AR','US-CA','US-CO','US-CT','US-DE','US-DC','US-FL',
       'US-GA','US-HI','US-ID','US-IL','US-IN','US-IA','US-KS','US-KY','US-LA','US-ME',
       'US-MD','US-MA','US-MI','US-MN','US-MS','US-MO','US-MT','US-NE','US-NV','US-NH',
       'US-NJ','US-NM','US-NY','US-NC','US-ND','US-OH','US-OK','US-OR','US-PA','US-RI',
       'US-SC','US-SD','US-TN','US-TX','US-UT','US-VT','US-VA','US-WA','US-WV','US-WI','US-WY'],
  CA: ['CA-AB','CA-BC','CA-MB','CA-NB','CA-NL','CA-NT','CA-NS','CA-NU','CA-ON','CA-PE',
       'CA-QC','CA-SK','CA-YT'],
};

// Reduction de la zone allouee au corps principal pour degager la place des encarts.
// Par defaut le pays occupe presque tout le viewBox, ce qui le fait chevaucher ses
// encarts : l'Espagne continentale descendait jusqu'a y=809 alors que les Canaries
// etaient posees a partir de y=700. box = [x, y, w, h].
const MAIN_BOX = {
  ES: [20, 10, 960, 670],   // laisse la bande basse libre pour les Canaries
};

// Certaines regions trainent un chapelet d'ilots tres lointains qui etire leur bbox et
// ecrase la partie habitee. Hawai porte ainsi les iles du Nord-Ouest jusqu'a Midway :
// 23.5 degres de longitude au lieu de 5.4 pour les huit iles principales, qui se
// retrouvaient reduites a 8 pixels. On ne garde que les anneaux dans la fenetre indiquee.
const CLIP_LON = {
  'US-HI': { min: -161 },   // ecarte Midway, Kure et le reste de la chaine du Nord-Ouest
};

// Territoires eloignes places en encart (sinon ils etirent la bbox et ecrasent le pays).
// box = [x, y, w, h] dans le viewBox 1000x900.
// Poses a DROITE : le corps du pays reste centre dans le cadre, et la colonne de droite est
// vide sur la plupart des cartes. A gauche, ils poussaient l Espagne et le Portugal de cote.
// Ceuta et Melilla ne sont pas loin mais minuscules - 7 et 3 px sur la carte, invisibles et
// incliquables. Elles rejoignent donc les encarts, pour la taille et non pour la distance.
const INSETS = {
  US: { 'US-AK': [10, 600, 260, 260], 'US-HI': [285, 720, 170, 145] },
  PT: { 'PT-20': [650, 80, 330, 190], 'PT-30': [650, 310, 330, 110] },
  ES: { 'ES-CN': [650, 600, 330, 170],
        'ES-CE': [680, 800, 90, 62], 'ES-ML': [830, 800, 90, 62] },
  NZ: { 'NZ-CI': [780, 20, 200, 160] },
};

// ---------------------------------------------------------------------------
// Douglas-Peucker (repris de simplify-regions-fr.mjs)
// ---------------------------------------------------------------------------
function perpDist(p, a, b){
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if(dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx*dx + dy*dy);
  const cx = ax + t*dx, cy = ay + t*dy;
  return Math.hypot(px - cx, py - cy);
}
function douglasPeucker(pts, tol){
  if(pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const end = pts.length - 1;
  for(let i = 1; i < end; i++){
    const d = perpDist(pts[i], pts[0], pts[end]);
    if(d > maxD){ maxD = d; idx = i; }
  }
  if(maxD > tol){
    const left = douglasPeucker(pts.slice(0, idx + 1), tol);
    const right = douglasPeucker(pts.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[end]];
}

// ---------------------------------------------------------------------------
// Dissolve : pour ES/IT/GB, une region eBird agrege plusieurs features NE (provinces,
// comtes). Sans traitement, chaque province garde son contour et la mini-carte affiche
// des frontieres internes parasites. On supprime les aretes partagees : une arete
// presente exactement 2 fois est interne (deux provinces voisines), une arete presente
// 1 fois est sur le bord exterieur. On rechaine ensuite les aretes restantes en anneaux.
// Marche parce que Natural Earth utilise des sommets identiques des deux cotes d'une
// frontiere partagee. Si le rechainage echoue, on retombe sur les anneaux d'origine.
// ---------------------------------------------------------------------------
const ptKey = ([lon, lat]) => lon.toFixed(6) + ',' + lat.toFixed(6);

function dissolveRings(rings){
  const edgeCount = new Map();   // cle arete non orientee -> nb d'occurrences
  const edgeData = new Map();    // cle arete -> [ptA, ptB]
  for(const ring of rings){
    for(let i = 0; i < ring.length - 1; i++){
      const a = ring[i], b = ring[i+1];
      const ka = ptKey(a), kb = ptKey(b);
      if(ka === kb) continue;
      const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      if(!edgeData.has(key)) edgeData.set(key, [a, b]);
    }
  }
  // Aretes de bord = celles vues une seule fois.
  const adj = new Map();   // cle point -> [{to, toKey}]
  let nBoundary = 0;
  for(const [key, n] of edgeCount){
    if(n !== 1) continue;
    nBoundary++;
    const [a, b] = edgeData.get(key);
    const ka = ptKey(a), kb = ptKey(b);
    if(!adj.has(ka)) adj.set(ka, []);
    if(!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ pt: b, key: kb });
    adj.get(kb).push({ pt: a, key: ka });
  }
  if(!nBoundary) return null;
  // Rechainage : on part d'un point non visite et on suit les voisins disponibles.
  const used = new Set();   // cles d'aretes consommees
  const out = [];
  const ptOf = new Map();
  for(const ring of rings) for(const p of ring) if(!ptOf.has(ptKey(p))) ptOf.set(ptKey(p), p);
  for(const startKey of adj.keys()){
    // Amorce un anneau tant qu'il reste une arete libre sur ce point.
    for(;;){
      const first = (adj.get(startKey) || []).find(n => !used.has(startKey + '|' + n.key) && !used.has(n.key + '|' + startKey));
      if(!first) break;
      const ring = [ptOf.get(startKey)];
      let curKey = startKey;
      let guard = 0;
      for(;;){
        if(++guard > 200000) return null;   // securite anti-boucle infinie
        const next = (adj.get(curKey) || []).find(n => !used.has(curKey + '|' + n.key) && !used.has(n.key + '|' + curKey));
        if(!next) break;
        used.add(curKey + '|' + next.key);
        ring.push(next.pt);
        curKey = next.key;
        if(curKey === startKey) break;   // anneau ferme
      }
      if(ring.length >= 4) out.push(ring);
    }
  }
  return out.length ? out : null;
}

const ringsOf = (geom) => {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const out = [];
  for(const poly of polys) for(const ring of poly) out.push(ring);
  return out;
};

// Alaska/Aleoutiennes et Nouvelle-Zelande traversent l'antimeridien : sans normalisation
// la bbox couvre ~360 degres et tout s'ecrase. On decale les longitudes negatives de +360.
// Decision prise sur l'ENSEMBLE des anneaux passes (un groupe coherent : soit tout le pays,
// soit un encart) - faire ce test region par region produirait des decalages incoherents.
function needsAntimeridianShift(ringSets){
  let hasFarWest = false, hasFarEast = false;
  for(const rings of ringSets) for(const r of rings) for(const [lon] of r){
    if(lon < -150) hasFarWest = true;
    if(lon > 150) hasFarEast = true;
  }
  return hasFarWest && hasFarEast;
}
const shiftRings = (rings) => rings.map(r => r.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]));

function bboxOf(ringSets){
  let minLon = 1e9, minLat = 1e9, maxLon = -1e9, maxLat = -1e9;
  for(const rings of ringSets) for(const r of rings) for(const [lon, lat] of r){
    if(lon < minLon) minLon = lon;
    if(lon > maxLon) maxLon = lon;
    if(lat < minLat) minLat = lat;
    if(lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

// Projection Mercator simplifiee (equirectangulaire corrigee par cos(lat)) : conserve
// des proportions correctes loin de l'equateur (Norvege, Alaska, Islande).
function makeProjector(bbox, box){
  const [bx, by, bw, bh] = box;
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const kx = Math.cos(midLat * Math.PI / 180);
  const spanX = (bbox.maxLon - bbox.minLon) * kx || 1e-6;
  const spanY = (bbox.maxLat - bbox.minLat) || 1e-6;
  // Conserve le ratio : on prend l'echelle la plus contraignante et on centre.
  const scale = Math.min(bw / spanX, bh / spanY);
  const offX = bx + (bw - spanX * scale) / 2;
  const offY = by + (bh - spanY * scale) / 2;
  return ([lon, lat]) => [
    offX + (lon - bbox.minLon) * kx * scale,
    offY + (bbox.maxLat - lat) * scale,
  ];
}

const W = 1000, H = 900;

function buildCountry(features, cc){
  // 1. Regroupe les features par code eBird (ES/IT/GB agregent plusieurs provinces).
  const allowed = new Set(EBIRD_REGIONS[cc] || []);
  const byCode = {};
  const neNames = {};
  let skipped = 0;
  for(const f of features){
    const code = resolveCode(cc, f.properties);
    if(!code || !allowed.has(code)){ skipped++; continue; }
    (byCode[code] = byCode[code] || []).push(...ringsOf(f.geometry));
    if(!neNames[code]) neNames[code] = f.properties.name_fr || f.properties.name;
  }
  // Retire les ilots hors fenetre avant tout calcul de bbox (cf. CLIP_LON).
  let clipped = 0;
  for(const [code, fenetre] of Object.entries(CLIP_LON)){
    if(!byCode[code]) continue;
    const avant = byCode[code].length;
    byCode[code] = byCode[code].filter(ring => {
      const lons = ring.map(p => p[0]);
      if(fenetre.min != null && Math.max(...lons) < fenetre.min) return false;
      if(fenetre.max != null && Math.min(...lons) > fenetre.max) return false;
      return true;
    });
    clipped += avant - byCode[code].length;
  }

  const codes = Object.keys(byCode);
  if(!codes.length) return null;
  const missing = [...allowed].filter(c => !byCode[c]);

  // 1bis. ES/IT/GB : fusionne les provinces d'une meme region eBird en supprimant
  // leurs frontieres internes. Les autres pays sont deja en 1:1 avec eBird.
  let dissolved = 0, dissolveFailed = 0;
  if(AGGREGATED.has(cc)){
    for(const code of codes){
      const merged = dissolveRings(byCode[code]);
      if(merged){ byCode[code] = merged; dissolved++; }
      else dissolveFailed++;
    }
  }

  // 2. Separe les encarts du corps principal.
  const insetCfg = INSETS[cc] || {};
  const mainCodes = codes.filter(c => !insetCfg[c]);
  const insetCodes = codes.filter(c => insetCfg[c]);

  // 3. Normalise l'antimeridien par groupe coherent (corps principal, puis chaque encart).
  if(needsAntimeridianShift(mainCodes.map(c => byCode[c]))){
    for(const c of mainCodes) byCode[c] = shiftRings(byCode[c]);
  }
  for(const c of insetCodes){
    if(needsAntimeridianShift([byCode[c]])) byCode[c] = shiftRings(byCode[c]);
  }

  const mainBbox = bboxOf(mainCodes.map(c => byCode[c]));
  // Marge de 2% pour que les traits de bord ne soient pas coupes, sauf override.
  const mainBox = MAIN_BOX[cc] || [W * 0.02, H * 0.02, W * 0.96, H * 0.96];
  const projectors = {};
  for(const c of mainCodes) projectors[c] = makeProjector(mainBbox, mainBox);
  for(const c of insetCodes) projectors[c] = makeProjector(bboxOf([byCode[c]]), insetCfg[c]);

  // 4. Tolerance adaptee a l'etendue du pays : vise un rendu equivalent a l'ecran
  //    quelle que soit la taille (0.008 deg pour la France ~ span 11 deg).
  const span = Math.max(mainBbox.maxLon - mainBbox.minLon, mainBbox.maxLat - mainBbox.minLat);
  const tol = Math.max(0.004, span * 0.0007);

  const out = {};
  for(const code of codes){
    const project = projectors[code];
    const paths = [];
    for(const ring of byCode[code]){
      // Ignore les micro-ilots : sous 6 points apres simplification ils n'apportent rien
      // mais gonflent le fichier (l'Alaska a ~2000 anneaux d'iles).
      const simplified = douglasPeucker(ring, tol);
      if(simplified.length < 4) continue;
      const proj = simplified.map(project);
      paths.push('M' + proj.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z');
    }
    if(!paths.length) continue;
    out[code] = { name: NAMES[code] || neNames[code] || code, path: paths.join(' ') };
  }
  return { out, skipped, tol, missing, dissolved, dissolveFailed, clipped,
           nRings: codes.reduce((a,c) => a + byCode[c].length, 0) };
}

// ---------------------------------------------------------------------------
const srcPath = process.argv[2];
if(!srcPath){
  console.error('Usage : node tools/build/simplify-regions-multi.mjs <ne_admin1.geojson> [pays]');
  process.exit(1);
}
const ADM0 = {
  GB:'GBR', ES:'ESP', IT:'ITA', PT:'PRT', CH:'CHE', NO:'NOR', GR:'GRC',
  IS:'ISL', LK:'LKA', NA:'NAM', AU:'AUS', NZ:'NZL', US:'USA', CA:'CAN',
  // Europe, ajoutee le 2026-09-26. Codes ISO alpha-3, ceux que Natural Earth met
  // dans adm0_a3.
  DE:'DEU', NL:'NLD', BE:'BEL', AT:'AUT', PL:'POL', CZ:'CZE', SK:'SVK', HU:'HUN',
  RO:'ROU', BG:'BGR', HR:'HRV', RS:'SRB', BA:'BIH', AL:'ALB', SI:'SVN',
  DK:'DNK', SE:'SWE', FI:'FIN', EE:'EST', LT:'LTU', LV:'LVA', BY:'BLR',
  UA:'UKR', RU:'RUS', IE:'IRL', CY:'CYP', LV:'LVA',
};
const filter = process.argv[3];
const COUNTRIES = filter ? filter.split(',').map(s => s.trim().toUpperCase()) : Object.keys(ADM0);

console.log(`Lecture ${srcPath} ...`);
const raw = JSON.parse(readFileSync(srcPath, 'utf8'));
console.log(`  ${raw.features.length} features admin-1 mondiales.\n`);

let totalKB = 0;
for(const cc of COUNTRIES){
  const a3 = ADM0[cc];
  if(!a3){ console.warn(`${cc} : pays inconnu, skip.`); continue; }
  // Le second test rattrape les regions que Natural Earth range sous un autre pays que
  // celui qui les code : la Crimee et Sebastopol y sont sous adm0_a3 = RUS alors qu'eBird
  // les appelle UA-43 et UA-40.
  const feats = raw.features.filter(f => f.properties.adm0_a3 === a3
    || (f.properties.iso_3166_2 || '').startsWith(cc + '-'));
  const res = buildCountry(feats, cc);
  if(!res){ console.warn(`${cc} : aucune region resolue sur ${feats.length} features.`); continue; }
  const payload = { viewBox: `0 0 ${W} ${H}`, regions: res.out };
  const json = JSON.stringify(payload);
  const outFile = join(OUT_DIR, `regions-${cc.toLowerCase()}-simplified.json`);
  writeFileSync(outFile, json);
  const kb = json.length / 1024;
  totalKB += kb;
  console.log(`${cc}: ${Object.keys(res.out).length}/${EBIRD_REGIONS[cc].length} regions, ` +
    `${res.nRings} anneaux bruts, tol=${res.tol.toFixed(4)}deg -> ${kb.toFixed(1)} KB`);
  if(res.missing.length) console.warn(`  ⚠ MANQUE : ${res.missing.join(',')}`);
  if(res.clipped) console.log(`  clip : ${res.clipped} ilots lointains retires (CLIP_LON)`);
  if(res.dissolved) console.log(`  dissolve : ${res.dissolved} regions fusionnees` +
    (res.dissolveFailed ? `, ${res.dissolveFailed} en echec (contours d'origine gardes)` : ''));
}
console.log(`\nTotal : ${totalKB.toFixed(1)} KB sur ${COUNTRIES.length} pays.`);
