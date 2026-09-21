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
  // NO : eBird utilise les anciens codes 19 fylker (avant reforme 2020).
  NO: ['NO-01','NO-02','NO-03','NO-04','NO-05','NO-06','NO-07','NO-08',
       'NO-09','NO-10','NO-11','NO-12','NO-14','NO-15','NO-16','NO-17',
       'NO-18','NO-19','NO-20'],
  GR: ['GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I',
       'GR-J','GR-K','GR-L','GR-M'],
  IS: ['IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8'],
  // LK : eBird utilise 25 districts (pas 9 provinces).
  LK: ['LK-11','LK-12','LK-13','LK-21','LK-22','LK-23','LK-31','LK-32',
       'LK-33','LK-41','LK-42','LK-43','LK-44','LK-45','LK-51','LK-52',
       'LK-53','LK-61','LK-62','LK-71','LK-72','LK-81','LK-82','LK-91',
       'LK-92'],
  // NA : 13 regions (retire NA-KE, NA-KW inexistants ; ajoute NA-OK).
  NA: ['NA-CA','NA-ER','NA-HA','NA-KA','NA-KH','NA-KU','NA-OD','NA-OH',
       'NA-OK','NA-ON','NA-OS','NA-OT','NA-OW'],
  // Ajout 2026-09-21 : Australie (8 etats/territoires).
  // Note : le bar chart national AU echoue (dataset trop gros cote eBird),
  // on ne downloade que les 8 regions et on agrege plus tard si besoin.
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  // Ajout 2026-09-21 : Nouvelle-Zelande (17 regions).
  NZ: ['NZ-AUK','NZ-BOP','NZ-CAN','NZ-CI','NZ-GIS','NZ-HKB','NZ-MWT','NZ-MBH',
       'NZ-NSN','NZ-NTL','NZ-OTA','NZ-STL','NZ-TKI','NZ-TAS','NZ-WKO','NZ-WGN',
       'NZ-WTC'],
};

const COOKIE = process.env.EBIRD_COOKIE;
if (!COOKIE) {
  console.error('ERREUR : variable EBIRD_COOKIE non set.');
  console.error('Usage : EBIRD_COOKIE="valeur..." node tools/download-bar-charts-regional.mjs');
  process.exit(1);
}

const SLEEP_MS = 5000;   // courtoisie eBird : 5s entre requetes (anti-bot anubis strict)
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
        'Referer': `https://ebird.org/barchart?r=${region}`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
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
  // Pays trop gros pour le bar chart national (page eBird "Oups!") : on skip
  // le national et on ne downloade que les regions.
  const SKIP_NATIONAL = new Set(['AU']);
  for (const [country, regions] of Object.entries(REGIONS)) {
    const skipNat = SKIP_NATIONAL.has(country);
    const allRegions = skipNat ? [...regions] : [country, ...regions];
    console.log(`\n=== ${country} (${allRegions.length} fichiers : ${skipNat ? 0 : 1} national + ${regions.length} regions) ===`);
    for (const region of allRegions) {
      const res = await downloadOne(region);
      results.push(res);
      if (res.status === 'invalid') {
        console.error('\nARRET : cookie EBIRD_SESSIONID probablement expire ou invalide.');
        console.error('Refaire login sur ebird.org + regenerer le cookie.');
        process.exit(1);
      }
      // Sleep uniquement apres un vrai download (pas sur SKIP)
      if (res.status === 'ok' || res.status === 'err') {
        await sleep(SLEEP_MS);
      }
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
