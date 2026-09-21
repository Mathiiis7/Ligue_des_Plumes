#!/usr/bin/env node
/*
  simplify-regions-fr.mjs - Simplifie regions-fr.geojson pour le mini-map species card.
  Cible : ~20-50 KB (vs 1.4 MB brut). Utilise decimation Douglas-Peucker simplifiee.

  Sortie : data/regions-fr-simplified.json
  Format : { "FR-XX": { name, path } } ou path est une chaine SVG "M x y L x y..."
  Projection : Mercator simple (lon/lat -> x/y) avec viewBox calcule.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const IN = join(__dir, '..', 'config', 'regions-fr.geojson');
const OUT = join(__dir, '..', '..', 'data', 'regions-fr-simplified.json');

// INSEE code -> eBird code
const INSEE_TO_EBIRD = {
  '11': 'FR-IDF', '24': 'FR-CVL', '27': 'FR-BFC', '28': 'FR-NOR',
  '32': 'FR-HDF', '44': 'FR-GES', '52': 'FR-PDL', '53': 'FR-BRE',
  '75': 'FR-NAQ', '76': 'FR-OCC', '84': 'FR-ARA', '93': 'FR-PAC',
  '94': 'FR-COR',
};

// Douglas-Peucker : distance perpendiculaire au segment (approx planaire, suffisant pour la France).
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

// Bbox global pour normaliser en viewBox.
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
// Projection : Mercator simplifiee, coordonnees dans [0, 1000] x [0, 900] pour viewBox.
const W = 1000, H = 900;
const project = ([lon, lat]) => {
  const x = ((lon - minLon) / (maxLon - minLon)) * W;
  const y = ((maxLat - lat) / (maxLat - minLat)) * H;
  return [x, y];
};

const TOL = 0.008;   // degres. Testons.
const out = {};
for(const f of raw.features){
  const inseeCode = f.properties.code;
  const ebirdCode = INSEE_TO_EBIRD[inseeCode];
  if(!ebirdCode){ console.warn(`Skip ${inseeCode} (pas de mapping eBird).`); continue; }
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
  console.log(`  ${ebirdCode} (${f.properties.nom}) : ${paths.length} anneau(x), ${out[ebirdCode].path.length} chars`);
}

const payload = { viewBox: `0 0 ${W} ${H}`, regions: out };
writeFileSync(OUT, JSON.stringify(payload));
const size = JSON.stringify(payload).length;
console.log(`\nEcrit ${OUT} (${(size/1024).toFixed(1)} KB).`);
