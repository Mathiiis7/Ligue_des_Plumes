#!/usr/bin/env node
/*
  build-range-gbif.mjs

  Fallback pour les especes NON couvertes par Cornell S&T. Utilise GBIF
  occurrences (data libre) pour generer une heatmap simplifiee par binning
  geographique. Meme extent monde et meme resolution que les cartes Cornell
  pour que le client les traite pareil.

  Sortie : data/range/{scislug}.png + mise a jour data/range-index.json
  avec _source:'gbif' pour differencier cote client.

  Usage : node tools/build/build-range-gbif.mjs
  Reprend si interrompu (skip especes deja dans range-index.json).
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const APP_JS = path.join(ROOT, 'app.js');
const RANGE_DIR = path.join(ROOT, 'data', 'range');
const MANIFEST = path.join(ROOT, 'data', 'range-index.json');

// ---------- Config ----------
const PNG_W = 1200, PNG_H = 850;
const BBOX = [-180, -60, 180, 85];   // meme que Cornell
const GRID_W = 240, GRID_H = 170;    // 1 cell = 5x5 pixels
const MAX_OCC = 500;                  // cap par espece pour rate limiter
const RATE_MS = 250;                  // 4 req/sec
const SAVE_EVERY = 20;                // manifest saved every N species

// Palette identique a Cornell (5 anchors verts -> rouge)
const PALETTE = [
  [62, 168, 107], [168, 209, 85], [245, 197, 24], [240, 115, 58], [161, 20, 8]
];

// Projection lat/lng -> pixel Mercator
function llToPx(lng, lat){
  const [w, s, e, n] = BBOX;
  const mercY = phi => Math.log(Math.tan(Math.PI/4 + (phi * Math.PI/180)/2));
  const mS = mercY(s), mN = mercY(n);
  const x = Math.floor(((lng - w) / (e - w)) * PNG_W);
  const y = Math.floor(PNG_H - ((mercY(lat) - mS) / (mN - mS)) * PNG_H);
  return [x, y];
}

// Interpole 2 couleurs RGB par t (0..1)
function lerpColor(c1, c2, t){
  return [
    Math.round(c1[0] + (c2[0]-c1[0])*t),
    Math.round(c1[1] + (c2[1]-c1[1])*t),
    Math.round(c1[2] + (c2[2]-c1[2])*t)
  ];
}
function paletteColor(t){
  // t : 0..1 -> couleur RGB interpolee sur les 5 anchors PALETTE
  const scaled = t * (PALETTE.length - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  if(i >= PALETTE.length - 1) return PALETTE[PALETTE.length - 1];
  return lerpColor(PALETTE[i], PALETTE[i+1], frac);
}

// ---------- Utils ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = sci => sci.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Lit FR_NAMES depuis app.js (source de verite des especes de l'app)
function readFrNames(){
  const content = fs.readFileSync(APP_JS, 'utf-8');
  const m = content.match(/const FR_NAMES\s*=\s*(\{[^;]*\});/);
  if(!m) throw new Error('FR_NAMES not found in app.js');
  return eval('(' + m[1] + ')');
}

// ---------- GBIF API ----------
async function gbifMatchSpecies(sci){
  const url = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}&kingdom=Animalia&class=Aves&strict=false`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const j = await r.json();
  return j?.usageKey || null;
}

async function gbifOccurrences(taxonKey){
  const points = [];
  const pageSize = 300;
  let offset = 0;
  while(points.length < MAX_OCC){
    const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${taxonKey}&hasCoordinate=true&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url);
    if(!r.ok) break;
    const j = await r.json();
    const results = j?.results || [];
    for(const rec of results){
      if(typeof rec.decimalLatitude === 'number' && typeof rec.decimalLongitude === 'number'){
        points.push([rec.decimalLongitude, rec.decimalLatitude]);
      }
    }
    if(results.length < pageSize || j.endOfRecords) break;
    offset += pageSize;
    await sleep(RATE_MS);
  }
  return points;
}

// ---------- Generation PNG ----------
function generatePng(points, outPath){
  // Binning : grille 240x170 (comptes par cellule)
  const grid = new Uint32Array(GRID_W * GRID_H);
  for(const [lng, lat] of points){
    const [x, y] = llToPx(lng, lat);
    if(x < 0 || y < 0 || x >= PNG_W || y >= PNG_H) continue;
    const gx = Math.floor(x / (PNG_W / GRID_W));
    const gy = Math.floor(y / (PNG_H / GRID_H));
    if(gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) continue;
    grid[gy * GRID_W + gx]++;
  }
  // Max pour normalisation log
  let maxCount = 0;
  for(const v of grid) if(v > maxCount) maxCount = v;
  if(maxCount === 0) return false;
  const logMax = Math.log1p(maxCount);
  // PNG 1200x850 RGBA, cells 5x5 pixels avec meme couleur/alpha
  const png = new PNG({ width: PNG_W, height: PNG_H, colorType: 6, filterType: -1 });
  // Init transparent
  png.data.fill(0);
  const cellW = PNG_W / GRID_W, cellH = PNG_H / GRID_H;
  for(let gy = 0; gy < GRID_H; gy++){
    for(let gx = 0; gx < GRID_W; gx++){
      const count = grid[gy * GRID_W + gx];
      if(count === 0) continue;
      const t = Math.log1p(count) / logMax;
      const [r, g, b] = paletteColor(t);
      // Alpha proportionnel a t (plancher 130 pour visibilite)
      const a = Math.min(255, Math.floor(130 + t * 125));
      // Fill le rect (cellW x cellH pixels)
      const px0 = Math.floor(gx * cellW), py0 = Math.floor(gy * cellH);
      const px1 = Math.min(PNG_W, Math.floor((gx+1) * cellW));
      const py1 = Math.min(PNG_H, Math.floor((gy+1) * cellH));
      for(let py = py0; py < py1; py++){
        for(let px = px0; px < px1; px++){
          const idx = (py * PNG_W + px) * 4;
          png.data[idx] = r;
          png.data[idx+1] = g;
          png.data[idx+2] = b;
          png.data[idx+3] = a;
        }
      }
    }
  }
  // Ecrit
  const buf = PNG.sync.write(png);
  fs.writeFileSync(outPath, buf);
  return true;
}

// ---------- Main ----------
console.log('Lecture FR_NAMES + manifest...');
const FR_NAMES = readFrNames();
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) : {};
// Normalise les cles du manifest en lowercase pour matcher FR_NAMES
const covered = new Set(Object.keys(manifest).map(k => k.toLowerCase()));

const allSciNames = Object.keys(FR_NAMES);
const todo = allSciNames.filter(sci => !covered.has(sci));
console.log(`Total FR_NAMES: ${allSciNames.length}, deja couvertes: ${covered.size}, restantes: ${todo.length}`);

if(!fs.existsSync(RANGE_DIR)) fs.mkdirSync(RANGE_DIR, { recursive: true });

const startTs = Date.now();
let success = 0, failed = 0, empty = 0;
for(let i = 0; i < todo.length; i++){
  const sci = todo[i];
  const sciSlug = slug(sci);
  const outPath = path.join(RANGE_DIR, sciSlug + '.png');
  process.stdout.write(`[${i+1}/${todo.length}] ${sci}... `);
  try{
    const taxonKey = await gbifMatchSpecies(sci);
    if(!taxonKey){ console.log('no taxonKey'); failed++; continue; }
    await sleep(RATE_MS);
    const points = await gbifOccurrences(taxonKey);
    if(points.length === 0){ console.log('no occurrences'); empty++; continue; }
    const ok = generatePng(points, outPath);
    if(!ok){ console.log('png gen failed'); failed++; continue; }
    manifest[sci] = { code: sciSlug, w: PNG_W, h: PNG_H, bbox: BBOX, _source: 'gbif', _n: points.length };
    success++;
    const elapsedMin = (Date.now() - startTs) / 60000;
    const rate = (i+1) / elapsedMin;
    const etaMin = (todo.length - (i+1)) / rate;
    console.log(`OK (${points.length} pts, ${elapsedMin.toFixed(1)}min elapsed, ETA ${etaMin.toFixed(0)}min)`);
  }catch(e){
    console.log('ERR:', e.message);
    failed++;
  }
  if((i+1) % SAVE_EVERY === 0){
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest));
    console.log(`  -- manifest saved (${success} succes, ${empty} vides, ${failed} echecs)`);
  }
  await sleep(RATE_MS);
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest));
console.log('\n=== Termine ===');
console.log(`Succes: ${success}, Vides: ${empty}, Echecs: ${failed}`);
console.log(`Manifest: ${MANIFEST}`);
