#!/usr/bin/env node
/*
  scrape-exotic-by-dep-fr.mjs - Scrape le statut exotique par departement FR (subnational2).
  96 departements (metropole + DOM), meme technique que scrape-exotic-by-region-fr.mjs.

  Sortie : tools/build/exotic-by-dep-fr.generated.js
  Format : { "FR-XXX-YY": { sciName: "N|P|X" } }
*/
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'exotic-by-dep-fr.generated.js');

// Codes departements fetches depuis eBird API 2026-09-21.
const FR_DEPS = [
  'FR-ARA-01','FR-HDF-02','FR-ARA-03','FR-PAC-04','FR-PAC-06','FR-ARA-07','FR-GES-08',
  'FR-OCC-09','FR-GES-10','FR-OCC-11','FR-OCC-12','FR-PAC-13','FR-NOR-14','FR-NOR-27',
  'FR-CVL-28','FR-BRE-29','FR-BFC-21','FR-BRE-22','FR-NAQ-23','FR-NAQ-24','FR-BFC-25',
  'FR-ARA-26','FR-OCC-30','FR-OCC-31','FR-OCC-32','FR-NAQ-33','FR-OCC-34','FR-BRE-35',
  'FR-CVL-36','FR-CVL-37','FR-ARA-38','FR-BFC-39','FR-NAQ-40','FR-CVL-41','FR-ARA-42',
  'FR-NAQ-47','FR-OCC-48','FR-PDL-49','FR-NOR-50','FR-GES-51','FR-GES-52','FR-PDL-53',
  'FR-GES-54','FR-GES-55','FR-BRE-56','FR-GES-57','FR-PDL-72','FR-ARA-73','FR-ARA-74',
  'FR-IDF-75C','FR-NOR-76','FR-IDF-77','FR-IDF-78','FR-NAQ-79','FR-HDF-80','FR-OCC-81',
  'FR-OCC-82','FR-PAC-83','FR-PAC-84','FR-PDL-85','FR-NAQ-86','FR-GES-88','FR-BFC-89',
  'FR-IDF-91','FR-IDF-92','FR-IDF-93','FR-IDF-94','FR-IDF-95','FR-PAC-05','FR-HDF-59',
  'FR-HDF-60','FR-NOR-61','FR-HDF-62','FR-ARA-69','FR-BFC-70','FR-BFC-71','FR-CVL-45',
  'FR-CVL-18','FR-OCC-46','FR-NAQ-16','FR-NAQ-17','FR-NAQ-19','FR-COR-2A','FR-COR-2B',
  'FR-NAQ-64','FR-OCC-65','FR-OCC-66','FR-GES-67','FR-GES-68','FR-BFC-58','FR-BFC-90',
  'FR-PDL-44','FR-ARA-43','FR-ARA-15',
  // Territoires outre-mer (DOM/COM)
  'FR-GF','FR-GP','FR-MQ','FR-YT','FR-RE',
];

async function scrapeDep(page, code) {
  console.log(`\n=== ${code} ===`);
  const url = `https://ebird.org/barchart?r=${code}&byr=2019&eyr=2026`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    try {
      await page.waitForSelector('.SpeciesName', { timeout: 20000 });
    } catch(e) {
      console.warn(`  (aucun .SpeciesName apres 20s)`);
    }
    await page.waitForTimeout(2000);
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
        const c = link.getAttribute('data-species-code');
        if(c) out[c] = cat;
      }
      return out;
    });
    const cats = {};
    for(const v of Object.values(data)) cats[v] = (cats[v]||0)+1;
    console.log(`  Extracted: ${Object.keys(data).length} exotiques`, cats);
    return data;
  } catch(err) {
    console.error(`  ERREUR ${code}:`, err.message);
    return {};
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'fr-FR',
});
const page = await ctx.newPage();

console.log(`Scrape de ${FR_DEPS.length} departements FR (~${Math.round(FR_DEPS.length * 0.5)} min).`);

// Taxonomy chargee AVANT la boucle : on ecrit le fichier apres chaque departement, il
// faut donc pouvoir convertir speciesCode -> sciName au fur et a mesure. Sans ca, une
// interruption en cours de route (Ctrl+C, veille) perdait les 50 minutes deja passees.
console.log('Fetching eBird taxonomy...');
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
  headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
})).json();
const codeToSci = {};
for(const t of tax) codeToSci[t.speciesCode] = (t.sciName || '').toLowerCase();
console.log(`  ${Object.keys(codeToSci).length} entrees taxonomiques\n`);

// Reprise : relit le fichier existant pour ne pas refaire les departements deja scrapes.
// --force ignore ce cache et repart de zero (cas d'un changement de fenetre temporelle).
const FORCE = process.argv.includes('--force');
const bySci = {};
if(!FORCE && existsSync(OUT)){
  try {
    const m = readFileSync(OUT, 'utf8').match(/EXOTIC_STATUS_BY_DEP_FR = (\{[\s\S]*?\});/);
    if(m) Object.assign(bySci, JSON.parse(m[1]));
    console.log(`Reprise : ${Object.keys(bySci).length} departements deja presents.\n`);
  } catch(e) { console.warn('  (fichier existant illisible, on repart de zero)'); }
}

const ecrire = () => writeFileSync(OUT,
  `// Genere par scrape-exotic-by-dep-fr.mjs (Playwright + Chromium headless).\n` +
  `// Fenetre eBird : 2019-2026, alignee sur les bar charts de frequence.\n` +
  `// Format : { "FR-XXX-YY": { sciName: category } } avec N=Naturalized, P=Provisional, X=Escapee.\n` +
  `export const EXOTIC_STATUS_BY_DEP_FR = ${JSON.stringify(bySci)};\n`
);

let i = 0;
for(const code of FR_DEPS) {
  i++;
  if(!FORCE && (code in bySci)){
    console.log(`[${i}/${FR_DEPS.length}] ${code} : SKIP (deja fait)`);
    continue;
  }
  process.stdout.write(`[${i}/${FR_DEPS.length}] `);
  const brut = await scrapeDep(page, code);
  const conv = {};
  for(const [sc, cat] of Object.entries(brut)) {
    const sci = codeToSci[sc];
    if(sci) conv[sci] = cat;
  }
  bySci[code] = conv;
  ecrire();   // sauvegarde apres chaque departement
}

ecrire();
console.log(`\n✓ Ecrit ${OUT}`);

const totalDeps = Object.keys(bySci).length;
const totalWithData = Object.values(bySci).filter(m => Object.keys(m).length > 0).length;
console.log(`\nRecap : ${totalWithData}/${totalDeps} départements avec au moins 1 exotique.`);

await browser.close();
