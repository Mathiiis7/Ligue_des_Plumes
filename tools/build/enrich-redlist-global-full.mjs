#!/usr/bin/env node
/*
  enrich-redlist-global-full.mjs , Fetch IUCN Global pour TOUTES les especes
  de FR_NAMES (11170) via GBIF, pas seulement celles dans nos data.

  Concurrence : 8 requetes en parallele pour aller plus vite (GBIF tres tolerant).
  Temps estime : ~15 min pour 11k especes.

  Sortie : tools/redlist.json enrichi (garde les fr existants, ajoute global manquants).
  Ensuite : node tools/inject-redlist.mjs pour reinjecter dans index.html.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const REDLIST_PATH = join(__dir, 'redlist.json');
const HTML_PATH = join(ROOT, 'index.html');
const PROGRESS_PATH = join(__dir, 'redlist-progress.json');

const redlist = JSON.parse(readFileSync(REDLIST_PATH, 'utf8'));
console.log('Redlist initial :', Object.keys(redlist).length, 'especes');

// Extract FR_NAMES from index.html
const html = readFileSync(HTML_PATH, 'utf8');
const frMatch = html.match(/const FR_NAMES = (\{.*?\});/s);
if (!frMatch) throw new Error('FR_NAMES introuvable');
const FR_NAMES = JSON.parse(frMatch[1]);
console.log('FR_NAMES :', Object.keys(FR_NAMES).length, 'especes');

// Progress cache (resume-able si crash)
let progress = {};
try { progress = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8')); } catch { progress = {}; }
console.log('Progress cache :', Object.keys(progress).length, 'especes deja fetchees');

// Filter : celles a fetcher (absentes de REDLIST.global valide ET pas dans progress)
const toFetch = Object.keys(FR_NAMES).filter(sci => {
  if (progress[sci]) return false;
  const e = redlist[sci];
  return !e || !e.global || e.global === 'NE';
});
console.log('A fetcher :', toFetch.length);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GBIF_MATCH = sci => `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}`;
const GBIF_IUCN = key => `https://api.gbif.org/v1/species/${key}/iucnRedListCategory`;

async function fetchOne(sci) {
  const parts = sci.split(' ');
  const scientificName = parts.length >= 2
    ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' ' + parts.slice(1).join(' ').toLowerCase()
    : sci;
  try {
    const matchR = await fetch(GBIF_MATCH(scientificName));
    if (!matchR.ok) return { sci, status: 'err' };
    const match = await matchR.json();
    const key = match.usageKey || match.acceptedUsageKey;
    if (!key) return { sci, status: 'notFound' };
    const iucnR = await fetch(GBIF_IUCN(key));
    if (!iucnR.ok) return { sci, status: iucnR.status === 404 ? 'notFound' : 'err' };
    const iucn = await iucnR.json();
    return { sci, status: iucn.code ? 'ok' : 'notFound', code: iucn.code };
  } catch (e) {
    return { sci, status: 'err', error: e.message };
  }
}

// Worker pool : 8 requetes en parallele
const CONCURRENCY = 8;
let ok = 0, notFound = 0, err = 0;
const startTime = Date.now();

let idx = 0;
async function worker() {
  while (idx < toFetch.length) {
    const i = idx++;
    const sci = toFetch[i];
    const r = await fetchOne(sci);
    progress[sci] = r.status;
    if (r.status === 'ok') {
      ok++;
      const existing = redlist[sci] || {};
      redlist[sci] = { fr: existing.fr || 'NE', global: r.code };
    } else if (r.status === 'notFound') notFound++;
    else err++;

    if (i % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      const rate = (i / (Date.now() - startTime) * 60000).toFixed(0);
      const eta = ((toFetch.length - i) / rate).toFixed(1);
      console.log(`  [${i}/${toFetch.length}] ok:${ok} notFound:${notFound} err:${err} , ${elapsed}min elapsed, ~${eta}min ETA (${rate}/min)`);
      // Save progress every 100
      writeFileSync(PROGRESS_PATH, JSON.stringify(progress));
      writeFileSync(REDLIST_PATH, JSON.stringify(redlist));
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// Final save
writeFileSync(REDLIST_PATH, JSON.stringify(redlist));
writeFileSync(PROGRESS_PATH, JSON.stringify(progress));

const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
console.log(`\n=== Termine en ${elapsedMin} min ===`);
console.log(`OK: ${ok}, NotFound: ${notFound}, Err: ${err}`);
console.log(`Redlist final : ${Object.keys(redlist).length} especes.`);

// Distribution
const dist = {};
for (const v of Object.values(redlist)) if (v.global) dist[v.global] = (dist[v.global] || 0) + 1;
console.log('\nDistribution IUCN Global :');
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k} : ${v}`);
}
console.log('\nEnsuite : node tools/inject-redlist.mjs pour re-injecter dans index.html');
