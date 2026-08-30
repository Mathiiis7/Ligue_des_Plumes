#!/usr/bin/env node
/*
  download-bar-charts-regional.mjs - Download automatique des bar charts eBird
  par region (admin1) pour ES/IT/GB/PT. Utilise le cookie de session Mathis
  passe en variable d'environnement EBIRD_COOKIE.

  Setup :
    1. Login sur ebird.org dans Chrome
    2. DevTools > Application > Cookies > https://ebird.org
    3. Copier la valeur du cookie EBIRD_SESSIONID (ou similaire)
    4. Lancer : EBIRD_COOKIE="valeur..." node tools/download-bar-charts-regional.mjs

  Sortie : tools/ebird-barchart-XX-YYYY-2019-2026.txt pour chaque region.
  Rate limit : delai 3s entre requetes (courtoisie envers eBird).
*/
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

const REGIONS = {
  GB: ['GB-ENG', 'GB-SCT', 'GB-WLS', 'GB-NIR'],
  PT: ['PT-01', 'PT-02', 'PT-03', 'PT-04', 'PT-05', 'PT-06', 'PT-07',
       'PT-08', 'PT-09', 'PT-10', 'PT-11', 'PT-12', 'PT-13', 'PT-14',
       'PT-15', 'PT-16', 'PT-17', 'PT-18', 'PT-20', 'PT-30'],
  ES: ['ES-AN', 'ES-AR', 'ES-AS', 'ES-CB', 'ES-CE', 'ES-CL', 'ES-CM',
       'ES-CN', 'ES-CT', 'ES-EX', 'ES-GA', 'ES-IB', 'ES-MC', 'ES-MD',
       'ES-ML', 'ES-NC', 'ES-PV', 'ES-RI', 'ES-VC'],
  IT: ['IT-21', 'IT-23', 'IT-25', 'IT-32', 'IT-34', 'IT-36', 'IT-42',
       'IT-45', 'IT-52', 'IT-55', 'IT-57', 'IT-62', 'IT-65', 'IT-67',
       'IT-72', 'IT-75', 'IT-77', 'IT-78', 'IT-82', 'IT-88'],
};

const COOKIE = process.env.EBIRD_COOKIE;
if (!COOKIE) {
  console.error('ERREUR : variable EBIRD_COOKIE non set.');
  console.error('Usage : EBIRD_COOKIE="valeur..." node tools/download-bar-charts-regional.mjs');
  process.exit(1);
}

const SLEEP_MS = 3000;   // courtoisie eBird : 3s entre requetes
const sleep = ms => new Promise(r => setTimeout(r, ms));

// eBird URL pour telecharger le bar chart en format tab-separated
// Format observe : https://ebird.org/barchart?byr=2019&eyr=2026&bmo=1&emo=12&r=REGION&fmt=tsv
// Retourne le fichier TSV avec les 48 quinzaines de frequence par espece.
function urlFor(region) {
  const params = new URLSearchParams({
    byr: '2019', eyr: '2026',
    bmo: '1', emo: '12',
    r: region, fmt: 'tsv',
  });
  return `https://ebird.org/barchartData?${params.toString()}`;
}

async function downloadOne(region) {
  const out = join(__dir, `ebird-barchart-${region}-2019-2026.txt`);
  if (existsSync(out)) {
    console.log(`  SKIP (deja present) : ${region}`);
    return { region, status: 'skip', size: 0 };
  }
  try {
    const r = await fetch(urlFor(region), {
      headers: {
        'Cookie': `EBIRD_SESSIONID=${COOKIE}`,
        'Accept': 'text/tab-separated-values,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; birdlist-app/1.0)',
      },
      redirect: 'follow',
    });
    if (!r.ok) {
      console.error(`  ERREUR ${region} : HTTP ${r.status}`);
      return { region, status: 'err', code: r.status };
    }
    const text = await r.text();
    // Verifie le contenu (pas une page HTML de login)
    if (text.startsWith('<') || text.length < 500) {
      console.error(`  ERREUR ${region} : contenu suspect (cookie invalide ?), taille ${text.length}`);
      console.error(`    Debut : ${text.slice(0, 100)}`);
      return { region, status: 'invalid', size: text.length };
    }
    writeFileSync(out, text);
    console.log(`  OK : ${region} (${text.length} bytes)`);
    return { region, status: 'ok', size: text.length };
  } catch (err) {
    console.error(`  ERREUR ${region} : ${err.message}`);
    return { region, status: 'err', msg: err.message };
  }
}

async function main() {
  console.log('Download bar charts regionaux eBird ES/IT/GB/PT');
  console.log('Total : ' + Object.values(REGIONS).flat().length + ' regions');
  console.log('Delai entre requetes : ' + SLEEP_MS + 'ms\n');

  const results = [];
  for (const [country, regions] of Object.entries(REGIONS)) {
    console.log(`\n=== ${country} (${regions.length} regions) ===`);
    for (const region of regions) {
      const res = await downloadOne(region);
      results.push(res);
      if (res.status === 'invalid') {
        console.error('\nARRET : cookie EBIRD_SESSIONID probablement expire ou invalide.');
        console.error('Refaire login sur ebird.org + regenerer le cookie.');
        process.exit(1);
      }
      await sleep(SLEEP_MS);
    }
  }

  // Recap
  const ok = results.filter(r => r.status === 'ok').length;
  const skip = results.filter(r => r.status === 'skip').length;
  const err = results.filter(r => r.status !== 'ok' && r.status !== 'skip').length;
  console.log(`\n=== RECAP ===`);
  console.log(`OK : ${ok}, deja present : ${skip}, erreurs : ${err}`);
  if (err > 0) {
    console.log('\nRegions en erreur :');
    for (const r of results.filter(x => x.status !== 'ok' && x.status !== 'skip')) {
      console.log(`  ${r.region} : ${r.status} ${r.code || r.msg || ''}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
