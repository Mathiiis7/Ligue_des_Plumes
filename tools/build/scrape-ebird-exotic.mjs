#!/usr/bin/env node
/*
  scrape-ebird-exotic.mjs - Scrape le statut exotique per-pays via la page bar chart eBird HTML.

  Utilise Playwright (Chromium headless) pour bypasser Anubis (proof-of-work anti-bot).
  Pour chaque pays, ouvre https://ebird.org/barchart?r={cc} et extrait les badges Exotic
  (Naturalized/Provisional/Escapee) affichés a cote de chaque espece.

  Usage : node tools/build/scrape-ebird-exotic.mjs
  Sortie : tools/build/exotic-per-country-scraped.generated.js
*/
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'exotic-per-country-scraped.generated.js');

const COUNTRIES = ['FR', 'ME', 'ES', 'IT', 'GB', 'PT', 'CH', 'NO', 'GR', 'IS', 'LK', 'NA', 'AU', 'NZ', 'US', 'CA'];
// Sous-set pour un run cible : CLI arg 1 en CSV, sinon tous. Ex: node scrape... AU,NZ
const CLI_COUNTRIES = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const RUN_COUNTRIES = CLI_COUNTRIES.length > 0 ? CLI_COUNTRIES : COUNTRIES;

// Regions pour pays trop gros (page nationale eBird echoue "Oups!") : on scrape
// chaque region et on merge par priorite N > P > X.
const REGION_FALLBACK = {
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  US: ['US-AL','US-AK','US-AZ','US-AR','US-CA','US-CO','US-CT','US-DE','US-DC',
       'US-FL','US-GA','US-HI','US-ID','US-IL','US-IN','US-IA','US-KS','US-KY',
       'US-LA','US-ME','US-MD','US-MA','US-MI','US-MN','US-MS','US-MO','US-MT',
       'US-NE','US-NV','US-NH','US-NJ','US-NM','US-NY','US-NC','US-ND','US-OH',
       'US-OK','US-OR','US-PA','US-RI','US-SC','US-SD','US-TN','US-TX','US-UT',
       'US-VT','US-VA','US-WA','US-WV','US-WI','US-WY'],
};

async function scrapeRegion(page, region) {
  const url = `https://ebird.org/barchart?r=${region}&byr=2019&eyr=2026`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(6000);
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
      const code = link.getAttribute('data-species-code');
      if(code) out[code] = cat;
    }
    return out;
  });
}

// Merge par priorite N > P > X (categorie la plus etablie gagne).
function mergeCat(existing, incoming){
  const rank = { N: 3, P: 2, X: 1, C: 1 };
  if(!existing) return incoming;
  return (rank[incoming] || 0) > (rank[existing] || 0) ? incoming : existing;
}

async function scrapeCountry(page, cc) {
  console.log(`\n=== ${cc} ===`);
  // Cas special : pays trop gros -> scrape par region + merge.
  if(REGION_FALLBACK[cc]) {
    console.log(`  Fallback regional (page nationale trop lourde) : ${REGION_FALLBACK[cc].length} regions`);
    const merged = {};
    for(const reg of REGION_FALLBACK[cc]) {
      try {
        const d = await scrapeRegion(page, reg);
        for(const [code, cat] of Object.entries(d)) merged[code] = mergeCat(merged[code], cat);
        console.log(`    ${reg}: +${Object.keys(d).length} (total merged: ${Object.keys(merged).length})`);
      } catch(e) {
        console.error(`    ${reg}: ERREUR ${e.message}`);
      }
    }
    console.log(`  Extracted (merged): ${Object.keys(merged).length} exotiques`);
    return merged;
  }
  // Cas normal : page pays.
  const url = `https://ebird.org/barchart?r=${cc}&byr=2019&eyr=2026`;
  console.log('  Navigating...');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  console.log('  Waiting for full render...');
  // Attend qu'au moins une .SpeciesName soit dans le DOM (rendu client-side).
  // Fallback : timeout 25s pour laisser le JS finir de dessiner tout le bar chart.
  try {
    await page.waitForSelector('.SpeciesName', { timeout: 25000 });
  } catch(e) {
    console.warn('  (aucun .SpeciesName apres 25s, on tente extract quand meme)');
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
  console.log(`  Extracted: ${Object.keys(data).length} exotiques`);
  return data;
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'fr-FR',
});
const page = await ctx.newPage();

const results = {};   // { cc: { speciesCode: cat } }
for(const cc of RUN_COUNTRIES) {
  try {
    results[cc] = await scrapeCountry(page, cc);
  } catch(e) {
    console.error(`  ERREUR ${cc}:`, e.message);
    results[cc] = {};
  }
}

// Convertit speciesCode -> sciName via l'API taxonomy eBird (une seule requete pour toutes les especes).
console.log('\nFetching eBird taxonomy...');
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
  headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
})).json();
const codeToSci = {};
for(const t of tax) codeToSci[t.speciesCode] = (t.sciName || '').toLowerCase();
console.log(`  Loaded ${Object.keys(codeToSci).length} taxonomy entries`);

// Convertit les resultats: speciesCode -> sciName
const bySci = {};
for(const [cc, m] of Object.entries(results)) {
  bySci[cc] = {};
  for(const [code, cat] of Object.entries(m)) {
    const sci = codeToSci[code];
    if(sci) bySci[cc][sci] = cat;
    else console.log(`  ${cc}: pas de sciName pour code ${code}`);
  }
}

writeFileSync(OUT,
  `// Genere par scrape-ebird-exotic.mjs (Playwright + Chromium headless) + conversion via API taxonomy.\n` +
  `// Ne pas editer a la main. Regenerable : node tools/build/scrape-ebird-exotic.mjs\n` +
  `export const EXOTIQUES_EBIRD_SCRAPED = ${JSON.stringify(bySci)};\n`
);
console.log(`\n✓ Ecrit ${OUT}`);
console.log('\nRecap:');
for(const cc of RUN_COUNTRIES) {
  const m = bySci[cc] || {};
  const cats = {};
  for(const v of Object.values(m)) cats[v] = (cats[v]||0)+1;
  console.log(`  ${cc}: ${Object.keys(m).length} total`, cats);
}

await browser.close();
