#!/usr/bin/env node
/*
  scrape-exotic-by-region-fr.mjs - Scrape le statut exotique par region FR.
  Meme technique que scrape-ebird-exotic.mjs mais itere sur les 13 regions
  (FR-ARA, FR-BFC, ...) pour capturer le detail geographique.

  Sortie : tools/build/exotic-by-region-fr.generated.js
  Format : { "FR-XX": { "sci name": "N|P|X", ... }, ... }
*/
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'exotic-by-region-fr.generated.js');

const FR_REGIONS = [
  'FR-ARA', 'FR-BFC', 'FR-BRE', 'FR-CVL', 'FR-COR', 'FR-GES', 'FR-HDF',
  'FR-NOR', 'FR-NAQ', 'FR-OCC', 'FR-PDL', 'FR-PAC', 'FR-IDF',
];

async function scrapeRegion(page, region) {
  console.log(`\n=== ${region} ===`);
  const url = `https://ebird.org/barchart?r=${region}&byr=2019&eyr=2026`;
  console.log('  Navigating...');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  console.log('  Waiting for full render...');
  try {
    await page.waitForSelector('.SpeciesName', { timeout: 25000 });
  } catch(e) {
    console.warn('  (aucun .SpeciesName apres 25s, tente extract quand meme)');
  }
  await page.waitForTimeout(3000);
  const data = await page.evaluate(() => {
    const out = {};
    const icons = document.querySelectorAll('[class*="Icon--exotic"]');
    for(const icon of icons) {
      let cat = null;
      const classes = [...(icon.classList || [])];
      if(classes.some(c => c.includes('Naturalized'))) cat = 'N';
      else if(classes.some(c => c.includes('Provisional'))) cat = 'P';
      else if(classes.some(c => c.includes('Escapee'))) cat = 'X';
      if(!cat) continue;
      const row = icon.closest('.SpeciesName') || icon.parentElement?.parentElement;
      if(!row) continue;
      const link = row.querySelector('a[data-species-code]');
      if(!link) continue;
      const code = link.getAttribute('data-species-code');
      if(code) out[code] = cat;
    }
    return out;
  });
  const cats = {};
  for(const v of Object.values(data)) cats[v] = (cats[v]||0)+1;
  console.log(`  Extracted: ${Object.keys(data).length} exotiques`, cats);
  return data;
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'fr-FR',
});
const page = await ctx.newPage();

const results = {};
for(const region of FR_REGIONS) {
  try {
    results[region] = await scrapeRegion(page, region);
  } catch(e) {
    console.error(`  ERREUR ${region}:`, e.message);
    results[region] = {};
  }
}

// Convertit speciesCode -> sciName via l'API taxonomy eBird.
console.log('\nFetching eBird taxonomy...');
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
  headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
})).json();
const codeToSci = {};
for(const t of tax) codeToSci[t.speciesCode] = (t.sciName || '').toLowerCase();
console.log(`  Loaded ${Object.keys(codeToSci).length} taxonomy entries`);

const bySci = {};
for(const [region, m] of Object.entries(results)) {
  bySci[region] = {};
  for(const [code, cat] of Object.entries(m)) {
    const sci = codeToSci[code];
    if(sci) bySci[region][sci] = cat;
  }
}

writeFileSync(OUT,
  `// Genere par scrape-exotic-by-region-fr.mjs (Playwright + Chromium headless).\n` +
  `// Ne pas editer a la main. Regenerable : node tools/build/scrape-exotic-by-region-fr.mjs\n` +
  `// Format : { "FR-XX": { sciName: category } } avec N=Naturalized, P=Provisional, X=Escapee.\n` +
  `export const EXOTIC_STATUS_BY_REGION_FR = ${JSON.stringify(bySci)};\n`
);
console.log(`\n✓ Ecrit ${OUT}`);
console.log('\nRecap par region :');
for(const region of FR_REGIONS) {
  const m = bySci[region] || {};
  const cats = {};
  for(const v of Object.values(m)) cats[v] = (cats[v]||0)+1;
  console.log(`  ${region}: ${Object.keys(m).length} total`, cats);
}

await browser.close();
