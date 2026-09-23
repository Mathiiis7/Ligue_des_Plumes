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

  CE COOKIE EST INDISPENSABLE, ET CE N EST PAS UNE QUESTION D ANTI-BOT.
  Verifie le 2026-09-23 : /barchartData exige une session authentifiee. Une requete sans
  cookie, meme depuis un vrai Chrome pilote par Playwright, est redirigee vers la page de
  connexion du Cornell Lab (secure.birds.cornell.edu/cassso/login). Il n y a donc pas de
  contournement possible par navigateur : il faut le cookie d une session connectee.
  La page HTML /barchart, elle, est publique — c est pourquoi les scrapers de statut
  exotique fonctionnent sans cookie, contrairement a ce telechargement.

  Filtrer les pays : passer leurs codes en arguments.
    EBIRD_COOKIE=... node tools/build/download-bar-charts-regional.mjs FR
  Sans argument, tous les pays de REGIONS sont parcourus (les fichiers deja presents sont
  ignores, donc un rerun complet ne retelecharge rien inutilement).
*/
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

const REGIONS = {
  // Ajout 2026-09-23 : les TSV regionaux FR couvraient 2015-2026 alors que le national et
  // les 15 autres pays sont sur 2019-2026, ce qui faisait divergier les cartes de rarete
  // par region du tier national de la meme espece.
  FR: ['FR-ARA','FR-BFC','FR-BRE','FR-COR','FR-CVL','FR-GES','FR-HDF',
       'FR-IDF','FR-NAQ','FR-NOR','FR-OCC','FR-PAC','FR-PDL',
       // Les 96 departements, sur la meme fenetre : ce sont eux que portent les cartes
       // departementales de la fiche espece, et ils etaient aussi sur 2015-2026.
       'FR-ARA-01','FR-ARA-03','FR-ARA-07','FR-ARA-15','FR-ARA-26','FR-ARA-38','FR-ARA-42',
       'FR-ARA-43','FR-ARA-63','FR-ARA-69','FR-ARA-73','FR-ARA-74','FR-BFC-21','FR-BFC-25',
       'FR-BFC-39','FR-BFC-58','FR-BFC-70','FR-BFC-71','FR-BFC-89','FR-BFC-90','FR-BRE-22',
       'FR-BRE-29','FR-BRE-35','FR-BRE-56','FR-COR-2A','FR-COR-2B','FR-CVL-18','FR-CVL-28',
       'FR-CVL-36','FR-CVL-37','FR-CVL-41','FR-CVL-45','FR-GES-08','FR-GES-10','FR-GES-51',
       'FR-GES-52','FR-GES-54','FR-GES-55','FR-GES-57','FR-GES-67','FR-GES-68','FR-GES-88',
       'FR-HDF-02','FR-HDF-59','FR-HDF-60','FR-HDF-62','FR-HDF-80','FR-IDF-75C','FR-IDF-77',
       'FR-IDF-78','FR-IDF-91','FR-IDF-92','FR-IDF-93','FR-IDF-94','FR-IDF-95','FR-NAQ-16',
       'FR-NAQ-17','FR-NAQ-19','FR-NAQ-23','FR-NAQ-24','FR-NAQ-33','FR-NAQ-40','FR-NAQ-47',
       'FR-NAQ-64','FR-NAQ-79','FR-NAQ-86','FR-NAQ-87','FR-NOR-14','FR-NOR-27','FR-NOR-50',
       'FR-NOR-61','FR-NOR-76','FR-OCC-09','FR-OCC-11','FR-OCC-12','FR-OCC-30','FR-OCC-31',
       'FR-OCC-32','FR-OCC-34','FR-OCC-46','FR-OCC-48','FR-OCC-65','FR-OCC-66','FR-OCC-81',
       'FR-OCC-82','FR-PAC-04','FR-PAC-05','FR-PAC-06','FR-PAC-13','FR-PAC-83','FR-PAC-84',
       'FR-PDL-44','FR-PDL-49','FR-PDL-53','FR-PDL-72','FR-PDL-85',
      ],
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
  AU: ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'],
  NZ: ['NZ-AUK','NZ-BOP','NZ-CAN','NZ-CI','NZ-GIS','NZ-HKB','NZ-MWT','NZ-MBH',
       'NZ-NSN','NZ-NTL','NZ-OTA','NZ-STL','NZ-TKI','NZ-TAS','NZ-WKO','NZ-WGN',
       'NZ-WTC'],
  // Ajout 2026-09-21 : Etats-Unis (50 etats + DC).
  US: ['US-AL','US-AK','US-AZ','US-AR','US-CA','US-CO','US-CT','US-DE','US-DC',
       'US-FL','US-GA','US-HI','US-ID','US-IL','US-IN','US-IA','US-KS','US-KY',
       'US-LA','US-ME','US-MD','US-MA','US-MI','US-MN','US-MS','US-MO','US-MT',
       'US-NE','US-NV','US-NH','US-NJ','US-NM','US-NY','US-NC','US-ND','US-OH',
       'US-OK','US-OR','US-PA','US-RI','US-SC','US-SD','US-TN','US-TX','US-UT',
       'US-VT','US-VA','US-WA','US-WV','US-WI','US-WY'],
  // Ajout 2026-09-21 : Canada (13 provinces/territoires).
  CA: ['CA-AB','CA-BC','CA-MB','CA-NB','CA-NL','CA-NT','CA-NS','CA-NU','CA-ON',
       'CA-PE','CA-QC','CA-SK','CA-YT'],
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

// Pays demandes en arguments (codes ISO). Vide = tous.
const PAYS_DEMANDES = process.argv.slice(2).filter(a => /^[A-Z]{2}$/.test(a.toUpperCase())).map(a => a.toUpperCase());

async function main() {
  console.log('Download bar charts eBird : national + regional par pays');
  const totalCalls = Object.entries(REGIONS).reduce((a, [c, r]) => a + 1 + r.length, 0);
  console.log('Total : ' + Object.keys(REGIONS).length + ' pays + ' + Object.values(REGIONS).flat().length + ' regions = ' + totalCalls + ' requetes');
  console.log('Delai entre requetes : ' + SLEEP_MS + 'ms\n');

  const results = [];
  // Note : la page HTML nationale eBird echoue "Oups!" pour AU/US (trop gros),
  // MAIS l'endpoint /barchartData renvoie bien le TSV. On downloade donc le national
  // pour tous les pays sans exception.
  for (const [country, regions] of Object.entries(REGIONS)) {
    if (PAYS_DEMANDES.length && !PAYS_DEMANDES.includes(country)) continue;
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
