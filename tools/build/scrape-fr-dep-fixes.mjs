#!/usr/bin/env node
/*
  scrape-fr-dep-fixes.mjs - Re-scrape 5 dep FR avec les BONS codes eBird
  (correction du scrape initial qui avait de mauvais prefixes region).
*/
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'exotic-by-dep-fr.generated.js');

const FIXES = [
  { wrong: 'FR-BFC-08', correct: 'FR-GES-08' },   // Ardennes
  { wrong: 'FR-NOR-90', correct: 'FR-BFC-90' },   // Territoire de Belfort
  { wrong: 'FR-BRE-44', correct: 'FR-PDL-44' },   // Loire-Atlantique
  { wrong: 'FR-OCC-43', correct: 'FR-ARA-43' },   // Haute-Loire
  { wrong: 'FR-BFC-15', correct: 'FR-ARA-15' },   // Cantal
];

async function scrapeDep(page, code) {
  const url = `https://ebird.org/barchart?r=${code}&byr=1900&eyr=2026`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  try {
    await page.waitForSelector('.SpeciesName', { timeout: 25000 });
  } catch(e) {
    console.warn(`  no .SpeciesName after 25s for ${code}`);
  }
  await page.waitForTimeout(3000);
  return await page.evaluate(() => {
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
      const c = link.getAttribute('data-species-code');
      if(c) out[c] = cat;
    }
    return out;
  });
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'fr-FR',
});
const page = await ctx.newPage();

const results = {};
for(const { wrong, correct } of FIXES) {
  console.log(`\nRe-scraping ${correct} (etait ${wrong})...`);
  results[correct] = await scrapeDep(page, correct);
  const cats = {};
  for(const v of Object.values(results[correct])) cats[v] = (cats[v]||0)+1;
  console.log(`  Extracted: ${Object.keys(results[correct]).length}`, cats);
}

// Convertit speciesCode -> sciName via API taxonomy
console.log('\nFetching eBird taxonomy...');
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
  headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
})).json();
const codeToSci = {};
for(const t of tax) codeToSci[t.speciesCode] = (t.sciName || '').toLowerCase();

// Load existing generated file
const existing = readFileSync(OUT, 'utf8');
const m = existing.match(/EXOTIC_STATUS_BY_DEP_FR = (\{[\s\S]*?\});/);
const data = JSON.parse(m[1]);

// Add corrected deps
for(const { wrong, correct } of FIXES) {
  const bySci = {};
  for(const [sc, cat] of Object.entries(results[correct] || {})) {
    const sci = codeToSci[sc];
    if(sci) bySci[sci] = cat;
  }
  data[correct] = bySci;
  delete data[wrong];   // supprime l'entree erronee vide
  console.log(`Set ${correct} = ${Object.keys(bySci).length} sp, removed ${wrong}`);
}

writeFileSync(OUT,
  `// Genere par scrape-exotic-by-dep-fr.mjs (Playwright + Chromium headless).\n` +
  `// Format : { "FR-XXX-YY": { sciName: category } } avec N=Naturalized, P=Provisional, X=Escapee.\n` +
  `// Fix 2026-09-22 : 5 dep re-scrapes avec bons codes (GES-08, BFC-90, PDL-44, ARA-43, ARA-15).\n` +
  `export const EXOTIC_STATUS_BY_DEP_FR = ${JSON.stringify(data)};\n`
);
console.log(`\n✓ Ecrit ${OUT}`);
await browser.close();
