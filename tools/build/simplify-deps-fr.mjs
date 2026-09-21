#!/usr/bin/env node
/*
  simplify-deps-fr.mjs - Simplifie departements-fr.geojson pour le mini-map species card.
  96 dep metropole, cible ~200-300 KB (avec 96 features).
  Meme technique que simplify-regions-fr.mjs (Douglas-Peucker + Mercator).

  Sortie : data/departements-fr-simplified.json
  Format : { viewBox, deps: { "FR-XXX-YY": { name, path } } }
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const IN = join(__dir, '..', 'config', 'departements-fr.geojson');
const OUT = join(__dir, '..', '..', 'data', 'departements-fr-simplified.json');

// INSEE dep code (2 chars, e.g. "02", "94") -> region eBird code.
// Etabli via cross-reference eBird API + INSEE.
const DEP_TO_REGION = {
  '01':'ARA','02':'HDF','03':'ARA','04':'PAC','05':'PAC','06':'PAC','07':'ARA','08':'GES',
  '09':'OCC','10':'GES','11':'OCC','12':'OCC','13':'PAC','14':'NOR','15':'ARA','16':'NAQ',
  '17':'NAQ','18':'CVL','19':'NAQ','21':'BFC','22':'BRE','23':'NAQ','24':'NAQ','25':'BFC',
  '26':'ARA','27':'NOR','28':'CVL','29':'BRE','2A':'COR','2B':'COR','30':'OCC','31':'OCC',
  '32':'OCC','33':'NAQ','34':'OCC','35':'BRE','36':'CVL','37':'CVL','38':'ARA','39':'BFC',
  '40':'NAQ','41':'CVL','42':'ARA','43':'ARA','44':'PDL','45':'CVL','46':'OCC','47':'NAQ',
  '48':'OCC','49':'PDL','50':'NOR','51':'GES','52':'GES','53':'PDL','54':'GES','55':'GES',
  '56':'BRE','57':'GES','58':'BFC','59':'HDF','60':'HDF','61':'NOR','62':'HDF','63':'ARA',
  '64':'NAQ','65':'OCC','66':'OCC','67':'GES','68':'GES','69':'ARA','70':'BFC','71':'BFC',
  '72':'PDL','73':'ARA','74':'ARA','75':'IDF','76':'NOR','77':'IDF','78':'IDF','79':'NAQ',
  '80':'HDF','81':'OCC','82':'OCC','83':'PAC','84':'PAC','85':'PDL','86':'NAQ','87':'NAQ',
  '88':'GES','89':'BFC','90':'BFC','91':'IDF','92':'IDF','93':'IDF','94':'IDF','95':'IDF',
};

// Douglas-Peucker.
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

const raw = JSON.parse(readFileSync(IN, 'utf8'));
console.log(`Charge ${raw.features.length} features (${(raw.features.reduce((a,f) => a + JSON.stringify(f).length, 0)/1024).toFixed(1)} KB brut).`);

// Bbox global.
let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
for(const f of raw.features){
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for(const poly of polys){
    for(const ring of poly){
      for(const [lon, lat] of ring){
        if(lon < minLon) minLon = lon;
        if(lon > maxLon) maxLon = lon;
        if(lat < minLat) minLat = lat;
        if(lat > maxLat) maxLat = lat;
      }
    }
  }
}
console.log(`Bbox : lon [${minLon}, ${maxLon}], lat [${minLat}, ${maxLat}]`);
const W = 1000, H = 900;
const project = ([lon, lat]) => {
  const x = ((lon - minLon) / (maxLon - minLon)) * W;
  const y = ((maxLat - lat) / (maxLat - minLat)) * H;
  return [x, y];
};

// Tolerance un peu plus stricte pour ne pas fusionner les tres petits dep.
const TOL = 0.006;
const out = {};
for(const f of raw.features){
  const dep = f.properties.code;   // '02', '75', '94', '2A', '75C', ...
  const region = DEP_TO_REGION[dep];
  if(!region){ console.warn(`Skip dep ${dep} (pas de mapping region).`); continue; }
  // Paris = '75' dans le geojson, mais eBird utilise 'FR-IDF-75C'. Applique le suffixe C
  // uniquement pour Paris (75). Corse : eBird a 2A/2B, geojson probablement pareil.
  const ebirdDep = dep === '75' ? '75C' : dep;
  const ebirdCode = `FR-${region}-${ebirdDep}`;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const paths = [];
  for(const poly of polys){
    for(const ring of poly){
      const simplified = douglasPeucker(ring, TOL);
      const proj = simplified.map(project);
      const path = 'M' + proj.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z';
      paths.push(path);
    }
  }
  out[ebirdCode] = { name: f.properties.nom, path: paths.join(' ') };
}
console.log(`\n${Object.keys(out).length} departements traites.`);

const payload = { viewBox: `0 0 ${W} ${H}`, deps: out };
writeFileSync(OUT, JSON.stringify(payload));
const size = JSON.stringify(payload).length;
console.log(`Ecrit ${OUT} (${(size/1024).toFixed(1)} KB).`);
