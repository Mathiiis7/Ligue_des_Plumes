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
};

// Pays ou une region eBird agrege plusieurs features Natural Earth (-> dissolve requis).
const AGGREGATED = new Set(['ES', 'IT', 'GB']);

function resolveCode(cc, props){
  if(cc === 'ES') return ES_HASC[props.code_hasc] || null;
  if(cc === 'IT') return IT_REGION[props.region] || null;
  if(cc === 'GB') return GB_UNIT[props.geonunit] || null;
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
  GB: ['GB-ENG','GB-SCT','GB-WLS','GB-NIR'],
  ES: ['ES-AN','ES-AR','ES-AS','ES-CB','ES-CE','ES-CL','ES-CM','ES-CN','ES-CT','ES-EX',
       'ES-GA','ES-IB','ES-MC','ES-MD','ES-ML','ES-NC','ES-PV','ES-RI','ES-VC'],
  IT: ['IT-21','IT-23','IT-25','IT-32','IT-34','IT-36','IT-42','IT-45','IT-52','IT-55',
       'IT-57','IT-62','IT-65','IT-67','IT-72','IT-75','IT-77','IT-78','IT-82','IT-88'],
  PT: ['PT-01','PT-02','PT-03','PT-04','PT-05','PT-06','PT-07','PT-08','PT-09','PT-10',
       'PT-11','PT-12','PT-13','PT-14','PT-15','PT-16','PT-17','PT-18','PT-20','PT-30'],
  CH: ['CH-AG','CH-AI','CH-AR','CH-BE','CH-BL','CH-BS','CH-FR','CH-GE','CH-GL','CH-GR',
       'CH-JU','CH-LU','CH-NE','CH-NW','CH-OW','CH-SG','CH-SH','CH-SO','CH-SZ','CH-TG',
       'CH-TI','CH-UR','CH-VD','CH-VS','CH-ZG','CH-ZH'],
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
const INSETS = {
  US: { 'US-AK': [10, 600, 260, 260], 'US-HI': [285, 720, 170, 145] },
  PT: { 'PT-20': [10, 20, 220, 180], 'PT-30': [10, 230, 160, 130] },
  ES: { 'ES-CN': [30, 706, 300, 170] },
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
  const feats = raw.features.filter(f => f.properties.adm0_a3 === a3);
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
