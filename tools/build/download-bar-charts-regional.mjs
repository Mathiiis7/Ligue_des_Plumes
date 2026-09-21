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
  // Ajout 2026-09-21 : nouveaux pays.
  CH: ['CH-AG','CH-AI','CH-AR','CH-BE','CH-BL','CH-BS','CH-FR','CH-GE',
       'CH-GL','CH-GR','CH-JU','CH-LU','CH-NE','CH-NW','CH-OW','CH-SG',
       'CH-SH','CH-SO','CH-SZ','CH-TG','CH-TI','CH-UR','CH-VD','CH-VS',
       'CH-ZG','CH-ZH'],
  NO: ['NO-03','NO-11','NO-15','NO-18','NO-30','NO-34','NO-38','NO-42',
       'NO-46','NO-50','NO-54'],
  GR: ['GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I',
       'GR-J','GR-K','GR-L','GR-M'],
  IS: ['IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8'],
  LK: ['LK-1','LK-2','LK-3','LK-4','LK-5','LK-6','LK-7','LK-8','LK-9'],
  NA: ['NA-CA','NA-ER','NA-HA','NA-KA','NA-KE','NA-KH','NA-KU','NA-OD',
       'NA-OH','NA-ON','NA-OS','NA-OT','NA-OW','NA-KW'],
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

// Cookie jar manuel : eBird renouvelle EBIRD_SESSIONID a chaque requete via Set-Cookie.
// On maintient un dict {name: value} et on l'update entre les requetes.
const cookieJar = {};
// Init avec le cookie initial (format 'name=value; name2=value2').
(COOKIE.includes('=') ? COOKIE : `EBIRD_SESSIONID=${COOKIE}`).split(';').forEach(kv => {
  const [k, v] = kv.trim().split('=');
  if (k && v) cookieJar[k] = v;
});
function cookieHeader() {
  return Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');
}
function updateJarFromSetCookie(headers) {
  // Node fetch : getSetCookie() sur les Response headers (v18+).
  const arr = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const raw of arr) {
    const first = raw.split(';')[0];   // "name=value"
    const [k, v] = first.split('=');
    if (k && v !== undefined) cookieJar[k.trim()] = v.trim();
  }
}

const OUT_DIR = join(__dir, '..', 'ebird-barcharts-raw');

async function downloadOne(region) {
  const out = join(OUT_DIR, `ebird-barchart-${region}-2019-2026.txt`);
  if (existsSync(out)) {
    console.log(`  SKIP (deja present) : ${region}`);
    return { region, status: 'skip', size: 0 };
  }
  try {
    const r = await fetch(urlFor(region), {
      headers: {
        'Cookie': cookieHeader(),
        'Accept': 'text/tab-separated-values,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    updateJarFromSetCookie(r.headers);
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
  console.log('Download bar charts eBird : national + regional par pays');
  const totalCalls = Object.entries(REGIONS).reduce((a, [c, r]) => a + 1 + r.length, 0);
  console.log('Total : ' + Object.keys(REGIONS).length + ' pays + ' + Object.values(REGIONS).flat().length + ' regions = ' + totalCalls + ' requetes');
  console.log('Delai entre requetes : ' + SLEEP_MS + 'ms\n');

  const results = [];
  for (const [country, regions] of Object.entries(REGIONS)) {
    // Downloade aussi le fichier national (r=CH par ex) en plus des regions.
    const allRegions = [country, ...regions];
    console.log(`\n=== ${country} (${allRegions.length} fichiers : 1 national + ${regions.length} regions) ===`);
    for (const region of allRegions) {
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
