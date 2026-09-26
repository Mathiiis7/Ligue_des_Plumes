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
  // --- Europe, ajoutee le 2026-09-26 ---
  DE: ['DE-BW','DE-BY','DE-BE','DE-BB','DE-HB','DE-HH','DE-HE','DE-MV',
       'DE-NI','DE-NW','DE-RP','DE-SL','DE-SN','DE-ST','DE-SH','DE-TH'],
  NL: ['NL-DR','NL-FL','NL-FR','NL-GE','NL-GR','NL-LI','NL-NB','NL-NH',
       'NL-OV','NL-UT','NL-ZE','NL-ZH'],
  PL: ['PL-DS','PL-KP','PL-LU','PL-LB','PL-MZ','PL-MA','PL-OP','PL-PK',
       'PL-PD','PL-PM','PL-WN','PL-WP','PL-ZP','PL-LD','PL-SL','PL-SK'],
  CZ: ['CZ-PR','CZ-JM','CZ-JC','CZ-KA','CZ-VY','CZ-KR','CZ-LI','CZ-MO',
       'CZ-OL','CZ-PA','CZ-PL','CZ-ST','CZ-ZL','CZ-US'],
  SK: ['SK-BC','SK-BL','SK-KI','SK-NI','SK-PV','SK-TC','SK-TA','SK-ZI'],
  RO: ['RO-AB','RO-AR','RO-AG','RO-BC','RO-BH','RO-BN','RO-BT','RO-BR',
       'RO-BV','RO-B','RO-BZ','RO-CL','RO-CS','RO-CJ','RO-CT','RO-CV',
       'RO-DJ','RO-DB','RO-GL','RO-GR','RO-GJ','RO-HR','RO-HD','RO-IL',
       'RO-IS','RO-IF','RO-MM','RO-MH','RO-MS','RO-NT','RO-OT','RO-PH',
       'RO-SJ','RO-SM','RO-SB','RO-SV','RO-TR','RO-TM','RO-TL','RO-VS',
       'RO-VN','RO-VL'],
  BG: ['BG-01','BG-02','BG-08','BG-07','BG-26','BG-09','BG-10','BG-11',
       'BG-12','BG-13','BG-14','BG-15','BG-16','BG-17','BG-18','BG-27',
       'BG-19','BG-20','BG-21','BG-23','BG-22','BG-24','BG-25','BG-03',
       'BG-04','BG-05','BG-06','BG-28'],
  HR: ['HR-07','HR-12','HR-19','HR-21','HR-18','HR-04','HR-06','HR-02',
       'HR-09','HR-20','HR-14','HR-11','HR-08','HR-03','HR-17','HR-05',
       'HR-10','HR-16','HR-13','HR-01','HR-15'],
  RS: ['RS-00','RS-14','RS-11','RS-23','RS-09','RS-08','RS-17','RS-20',
       'RS-24','RS-22','RS-10','RS-13','RS-19','RS-18','RS-21','RS-VO',
       'RS-15','RS-16','RS-12'],
  BA: ['BA-BIH','BA-SRP'],
  AL: ['AL-01','AL-09','AL-02','AL-03','AL-04','AL-05','AL-06','AL-07',
       'AL-08','AL-10','AL-11','AL-12'],
  SE: ['SE-K','SE-W','SE-I','SE-X','SE-N','SE-Z','SE-F','SE-H',
       'SE-G','SE-BD','SE-M','SE-AB','SE-D','SE-C','SE-S','SE-AC',
       'SE-Y','SE-U','SE-O','SE-T','SE-E'],
  FI: ['FI-08','FI-07','FI-05','FI-09','FI-10','FI-13','FI-14','FI-15',
       'FI-12','FI-11','FI-16','FI-17','FI-02','FI-03','FI-04','FI-19',
       'FI-06','FI-18','FI-01'],
  EE: ['EE-37','EE-39','EE-44','EE-51','EE-49','EE-59','EE-57','EE-67',
       'EE-65','EE-70','EE-74','EE-78','EE-82','EE-84','EE-86'],
  LT: ['LT-AL','LT-KU','LT-KL','LT-MR','LT-PN','LT-TA','LT-TE','LT-UT',
       'LT-VL','LT-SA'],
  BY: ['BY-BR','BY-HO','BY-HR','BY-MA','BY-MI','BY-VI'],
  UA: ['UA-71','UA-74','UA-77','UA-12','UA-14','UA-26','UA-63','UA-65',
       'UA-68','UA-35','UA-30','UA-32','UA-46','UA-09','UA-48','UA-51',
       'UA-53','UA-43','UA-56','UA-40','UA-59','UA-61','UA-05','UA-07',
       'UA-21','UA-23','UA-18'],
  RU: ['RU-AD','RU-ALT','RU-AL','RU-AMU','RU-ARK','RU-AST','RU-BA','RU-BEL',
       'RU-BRY','RU-BU','RU-CE','RU-CHE','RU-CHU','RU-CU','RU-DA','RU-IN',
       'RU-IRK','RU-IVA','RU-YEV','RU-KB','RU-KGD','RU-KL','RU-KLU','RU-KAM',
       'RU-KC','RU-KEM','RU-KHA','RU-KK','RU-KHM','RU-KIR','RU-KO','RU-KOS',
       'RU-KDA','RU-KYA','RU-KGN','RU-KRS','RU-LEN','RU-LIP','RU-MAG','RU-ME',
       'RU-MO','RU-MOW','RU-MOS','RU-MUR','RU-NEN','RU-NIZ','RU-SE','RU-NGR',
       'RU-NVS','RU-OMS','RU-ORE','RU-ORL','RU-PNZ','RU-PER','RU-PRI','RU-PSK',
       'RU-KR','RU-ROS','RU-RYA','RU-SPE','RU-SA','RU-SAK','RU-SAM','RU-SAR',
       'RU-SMO','RU-STA','RU-SVE','RU-TAM','RU-TA','RU-TOM','RU-TUL','RU-TY',
       'RU-TVE','RU-TYU','RU-UD','RU-ULY','RU-VLA','RU-VGG','RU-VLG','RU-VOR',
       'RU-YAN','RU-YAR','RU-CHI'],
  AT: ['AT-1','AT-2','AT-3','AT-4','AT-5','AT-6','AT-7','AT-8',
       'AT-9'],
  CY: ['CY-04','CY-06','CY-03','CY-01','CY-02','CY-05'],
  DK: ['DK-05','DK-06','DK-01','DK-13','DK-02','DK-12','DK-04','DK-08',
       'DK-09','DK-07','DK-10','DK-03','DK-11'],
  IE: ['IE-C','IE-L','IE-M','IE-U'],
  BE: ['BE-BRU','BE-VLG','BE-WAL'],
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

// Args CLI : [countries] [--force]
//   countries : subset separe par virgules (US,CA,GB), sinon tous
//   --force   : re-scrape TOUTES les regions meme celles deja faites
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const filterArg = args.find(a => !a.startsWith('--'));
const COUNTRIES = filterArg ? filterArg.split(',').map(s => s.trim().toUpperCase()) : Object.keys(REGIONS);
const totalRegions = COUNTRIES.reduce((a, c) => a + (REGIONS[c]?.length || 0), 0);
console.log(`Scrape exotic status per region : ${COUNTRIES.length} pays, ${totalRegions} regions.`);
if(FORCE) console.log(`Mode FORCE : re-scrape toutes les regions meme celles deja faites.`);
console.log(`Estim ~60s/region => ~${Math.round(totalRegions * 60 / 60)} min total.\n`);

async function scrapeRegion(page, region) {
  const url = `https://ebird.org/barchart?r=${region}&byr=2019&eyr=2026`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  try {
    await page.waitForSelector('.SpeciesName', { timeout: 45000 });
  } catch(e) {
    console.warn(`    (aucun .SpeciesName apres 45s, tente extract quand meme)`);
  }
  // Attente stabilisation : la liste peut etre en cours de render. On boucle jusqu'a
  // stabilisation du nombre de rows (max 40s) puis attente supplementaire pour les
  // icones exotic qui peuvent arriver apres. Grosses regions (GB-ENG, US-CA) sont
  // lentes a rendre : on prend le temps.
  await page.evaluate(async () => {
    let prev = -1, stable = 0, attempts = 0;
    while(attempts++ < 80 && stable < 5){
      const n = document.querySelectorAll('.SpeciesName').length;
      if(n === prev && n > 0) stable++; else stable = 0;
      prev = n;
      await new Promise(r => setTimeout(r, 500));
    }
  });
  // Scroll bottom -> top -> bottom pour trigger lazy-load des icones hors viewport
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  // Attente finale pour laisser les icones apparaitre
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
const tax = await (await fetch('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=fr_FR&cat=species', {
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
  // Resume : reprend un scrape interrompu si le fichier existe deja.
  // Skippe en mode --force pour tout re-scraper.
  let results = {};
  if(existsSync(outFile) && !FORCE){
    try {
      const src = readFileSync(outFile, 'utf8');
      const m = src.match(new RegExp(`EXOTIC_STATUS_BY_REGION_${cc}\\s*=\\s*({[\\s\\S]*?});`));
      if(m) results = JSON.parse(m[1]);
    } catch(e) { console.warn(`  (impossible parse existing ${outFile}, restart from scratch)`); }
  }

  console.log(`\n===== ${cc} (${regions.length} regions) =====`);
  for(const region of regions){
    done++;
    // Presence de la CLE (et pas contenu non vide) : une region sans exotique est un
    // resultat valide qu'il ne faut pas relancer indefiniment.
    if(!FORCE && (region in results)){
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
      // Un resultat vide est ambigu : soit la region n'a vraiment aucune exotique (cas
      // courant au Sri Lanka, 15 exotiques pour tout le pays), soit la liste n'a pas fini
      // de se rendre. On distingue sur totalRows : si les especes sont la, la page a bien
      // charge et 0 exotique est un vrai resultat qu'on conserve. Si la liste est vide
      // aussi, le scrape a echoue -> on retire l'entree pour qu'elle soit relancee.
      if(Object.keys(bySci).length === 0){
        if(totalRows > 0) console.log(`    (aucune exotique dans cette region - resultat conserve)`);
        else { console.warn(`    ⚠ liste d'especes vide : scrape rate, sera relance`); delete results[region]; }
      }
      // Sauvegarde progressive apres chaque region (resistance aux crashs)
      writeFileSync(outFile,
        `// Genere par scrape-exotic-by-region-multi.mjs (Playwright + Chromium headless).\n` +
        `// Ne pas editer a la main. Regenerable : node tools/build/scrape-exotic-by-region-multi.mjs ${cc}\n` +
        `// Format : { "${cc}-YY": { sciName: category } } avec N=Naturalized, P=Provisional, X=Escapee.\n` +
        `export const EXOTIC_STATUS_BY_REGION_${cc} = ${JSON.stringify(results)};\n`
      );
    } catch(e) {
      // Pas d'entree vide : la cle doit rester absente pour que le prochain run relance.
      console.error(`    ERREUR ${region}: ${e.message}`);
      delete results[region];
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
