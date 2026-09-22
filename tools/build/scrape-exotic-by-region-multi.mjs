#!/usr/bin/env node
/*
  scrape-exotic-by-region-multi.mjs - Scrape le statut exotique par region pour TOUS
  les pays multi-country supportes (hors FR qui est deja fait via scrape-exotic-by-
  region-fr.mjs). Meme technique : lit les icones .Icon--exotic* dans le HTML DOM
  d'eBird via Playwright + Chromium.

  Sortie : tools/build/exotic-by-region-<cc>.generated.js pour chaque pays.
  Format : { "XX-YY": { sciName: "N|P|X" } }

  Regions par pays (identiques a download-bar-charts-regional.mjs) :
    GB(4) ES(19) IT(20) PT(20) CH(26) NO(19) GR(13) IS(8) LK(25) NA(13)
    AU(8) NZ(17) US(51) CA(13) = 256 regions
    ~30s / region = ~2h total. Anubis anti-bot delays possibles.

  Usage :
    node tools/build/scrape-exotic-by-region-multi.mjs [country_filter]
    node tools/build/scrape-exotic-by-region-multi.mjs           # tous
    node tools/build/scrape-exotic-by-region-multi.mjs US        # juste US
    node tools/build/scrape-exotic-by-region-multi.mjs US,CA,GB  # subset
*/
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const REGIONS = {
  GB: ['GB-ENG', 'GB-SCT', 'GB-WLS', 'GB-NIR'],
  ES: ['ES-AN', 'ES-AR', 'ES-AS', 'ES-CB', 'ES-CE', 'ES-CL', 'ES-CM',
       'ES-CN', 'ES-CT', 'ES-EX', 'ES-GA', 'ES-IB', 'ES-MC', 'ES-MD',
       'ES-ML', 'ES-NC', 'ES-PV', 'ES-RI', 'ES-VC'],
  IT: ['IT-21', 'IT-23', 'IT-25', 'IT-32', 'IT-34', 'IT-36', 'IT-42',
       'IT-45', 'IT-52', 'IT-55', 'IT-57', 'IT-62', 'IT-65', 'IT-67',
       'IT-72', 'IT-75', 'IT-77', 'IT-78', 'IT-82', 'IT-88'],
  PT: ['PT-01', 'PT-02', 'PT-03', 'PT-04', 'PT-05', 'PT-06', 'PT-07',
       'PT-08', 'PT-09', 'PT-10', 'PT-11', 'PT-12', 'PT-13', 'PT-14',
       'PT-15', 'PT-16', 'PT-17', 'PT-18', 'PT-20', 'PT-30'],
  CH: ['CH-AG','CH-AI','CH-AR','CH-BE','CH-BL','CH-BS','CH-FR','CH-GE',
       'CH-GL','CH-GR','CH-JU','CH-LU','CH-NE','CH-NW','CH-OW','CH-SG',
       'CH-SH','CH-SO','CH-SZ','CH-TG','CH-TI','CH-UR','CH-VD','CH-VS',
       'CH-ZG','CH-ZH'],
  NO: ['NO-01','NO-02','NO-03','NO-04','NO-05','NO-06','NO-07','NO-08',
       'NO-09','NO-10','NO-11','NO-12','NO-14','NO-15','NO-16','NO-17',
       'NO-18','NO-19','NO-20'],
  GR: ['GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I',
       'GR-J','GR-K','GR-L','GR-M'],
  IS: ['IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8'],
  LK: ['LK-11','LK-12','LK-13','LK-21','LK-22','LK-23','LK-31','LK-32',
       'LK-33','LK-41','LK-42','LK-43','LK-44','LK-45','LK-51','LK-52',
       'LK-53','LK-61','LK-62','LK-71','LK-72','LK-81','LK-82','LK-91',
       'LK-92'],
  NA: ['NA-CA','NA-ER','NA-HA','NA-KA','NA-KH','NA-KU','NA-OD','NA-OH',
       'NA-OK','NA-ON','NA-OS','NA-OT','NA-OW'],
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  NZ: ['NZ-AUK','NZ-BOP','NZ-CAN','NZ-CI','NZ-GIS','NZ-HKB','NZ-MWT','NZ-MBH',
       'NZ-NSN','NZ-NTL','NZ-OTA','NZ-STL','NZ-TKI','NZ-TAS','NZ-WKO','NZ-WGN',
       'NZ-WTC'],
  US: ['US-AL','US-AK','US-AZ','US-AR','US-CA','US-CO','US-CT','US-DE','US-DC',
       'US-FL','US-GA','US-HI','US-ID','US-IL','US-IN','US-IA','US-KS','US-KY',
       'US-LA','US-ME','US-MD','US-MA','US-MI','US-MN','US-MS','US-MO','US-MT',
       'US-NE','US-NV','US-NH','US-NJ','US-NM','US-NY','US-NC','US-ND','US-OH',
       'US-OK','US-OR','US-PA','US-RI','US-SC','US-SD','US-TN','US-TX','US-UT',
       'US-VT','US-VA','US-WA','US-WV','US-WI','US-WY'],
  CA: ['CA-AB','CA-BC','CA-MB','CA-NB','CA-NL','CA-NT','CA-NS','CA-NU','CA-ON',
       'CA-PE','CA-QC','CA-SK','CA-YT'],
};

// Filter par CLI (subset)
const arg = process.argv[2];
const COUNTRIES = arg ? arg.split(',').map(s => s.trim().toUpperCase()) : Object.keys(REGIONS);
const totalRegions = COUNTRIES.reduce((a, c) => a + (REGIONS[c]?.length || 0), 0);
console.log(`Scrape exotic status per region : ${COUNTRIES.length} pays, ${totalRegions} regions.`);
console.log(`Estim ~30s/region => ~${Math.round(totalRegions * 30 / 60)} min total.\n`);

async function scrapeRegion(page, region) {
  const url = `https://ebird.org/barchart?r=${region}&byr=1900&eyr=2026`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  try {
    await page.waitForSelector('.SpeciesName', { timeout: 45000 });
  } catch(e) {
    console.warn(`    (aucun .SpeciesName apres 45s, tente extract quand meme)`);
  }
  // Attente : la liste peut etre en cours de render. On boucle jusqu'a stabilisation
  // du nombre de rows (max 20s) : evite les 0-exotique pour les grosses regions GB-ENG,
  // US-CA, IT-25 ou les icones lazy-load progressivement.
  await page.evaluate(async () => {
    let prev = -1, stable = 0, attempts = 0;
    while(attempts++ < 40 && stable < 3){
      const n = document.querySelectorAll('.SpeciesName').length;
      if(n === prev && n > 0) stable++; else stable = 0;
      prev = n;
      await new Promise(r => setTimeout(r, 500));
    }
  });
  // Scroll bottom pour trigger lazy-load restant
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);
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
    return { data: out, totalRows: document.querySelectorAll('.SpeciesName').length };
  });
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'fr-FR',
});
const page = await ctx.newPage();

// Fetch taxonomy une seule fois
console.log('Fetching eBird taxonomy...');
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr&cat=species', {
  headers: { 'X-eBirdApiToken': 'dbflh4atmsom' }
})).json();
const codeToSci = {};
for(const t of tax) codeToSci[t.speciesCode] = (t.sciName || '').toLowerCase();
console.log(`  ${Object.keys(codeToSci).length} taxonomy entries\n`);

let done = 0;
for(const cc of COUNTRIES) {
  const regions = REGIONS[cc];
  if(!regions){ console.warn(`Pas de regions pour ${cc}, skip.`); continue; }

  const outFile = join(__dir, `exotic-by-region-${cc.toLowerCase()}.generated.js`);
  // Resume : reprend un scrape interrompu si le fichier existe deja
  let results = {};
  if(existsSync(outFile)){
    try {
      const src = readFileSync(outFile, 'utf8');
      const m = src.match(new RegExp(`EXOTIC_STATUS_BY_REGION_${cc}\\s*=\\s*({[\\s\\S]*?});`));
      if(m) results = JSON.parse(m[1]);
    } catch(e) { console.warn(`  (impossible parse existing ${outFile}, restart from scratch)`); }
  }

  console.log(`\n===== ${cc} (${regions.length} regions) =====`);
  for(const region of regions){
    done++;
    if(results[region] && Object.keys(results[region]).length){
      console.log(`  [${done}/${totalRegions}] ${region} : SKIP (deja fait, ${Object.keys(results[region]).length} sp)`);
      continue;
    }
    try {
      console.log(`  [${done}/${totalRegions}] ${region} ...`);
      const { data: raw, totalRows } = await scrapeRegion(page, region);
      // Convert code -> sciName
      const bySci = {};
      for(const [code, cat] of Object.entries(raw)){
        const sci = codeToSci[code];
        if(sci) bySci[sci] = cat;
      }
      results[region] = bySci;
      const cats = {};
      for(const v of Object.values(bySci)) cats[v] = (cats[v]||0)+1;
      console.log(`    -> ${Object.keys(bySci).length} exotiques / ${totalRows} sp totales`, cats);
      // Warning si 0 exotiques sur une grosse region (probable rate de scrape)
      if(Object.keys(bySci).length === 0 && totalRows > 200){
        console.warn(`    ⚠ 0 exotiques trouvés dans ${totalRows} sp - possible timing manqué, à relancer`);
        // Force re-scrape en supprimant l'entrée (sinon le resume skip)
        delete results[region];
      }
      // Sauvegarde progressive apres chaque region (resistance aux crashs)
      writeFileSync(outFile,
        `// Genere par scrape-exotic-by-region-multi.mjs (Playwright + Chromium headless).\n` +
        `// Ne pas editer a la main. Regenerable : node tools/build/scrape-exotic-by-region-multi.mjs ${cc}\n` +
        `// Format : { "${cc}-YY": { sciName: category } } avec N=Naturalized, P=Provisional, X=Escapee.\n` +
        `export const EXOTIC_STATUS_BY_REGION_${cc} = ${JSON.stringify(results)};\n`
      );
    } catch(e) {
      console.error(`    ERREUR ${region}: ${e.message}`);
      results[region] = results[region] || {};
    }
  }
  console.log(`  ✓ Ecrit ${outFile}`);
}

console.log('\n===== Recap final =====');
for(const cc of COUNTRIES) {
  const f = join(__dir, `exotic-by-region-${cc.toLowerCase()}.generated.js`);
  if(!existsSync(f)) { console.log(`  ${cc} : PAS DE FICHIER`); continue; }
  const src = readFileSync(f, 'utf8');
  const m = src.match(new RegExp(`EXOTIC_STATUS_BY_REGION_${cc}\\s*=\\s*({[\\s\\S]*?});`));
  const d = m ? JSON.parse(m[1]) : {};
  let tot = 0;
  for(const rd of Object.values(d)) tot += Object.keys(rd).length;
  console.log(`  ${cc}: ${Object.keys(d).length} regions, ${tot} exotiques total`);
}

await browser.close();
