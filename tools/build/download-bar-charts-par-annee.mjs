#!/usr/bin/env node
/*
  download-bar-charts-par-annee.mjs - Telecharge le bar chart NATIONAL de chaque pays,
  une annee a la fois, pour savoir combien d'annees sur sept chaque espece a ete observee.

  POURQUOI
  Le bar chart 2019-2026 ecrase sept ans dans 48 creneaux : on y lit l'etalement d'une
  espece dans le calendrier, jamais son nombre d'occasions. Impossible d'y distinguer le
  Mergule nain, qui revient chaque hiver a des dates variables, du Gobemouche nain reste
  deux mois d'affilee une seule annee. Les deux occupent une poignee de creneaux.

  En telechargeant annee par annee, une espece presente dans le fichier de 2021 y a ete vue
  au moins une fois cette annee-la. Compter sur les sept fichiers donne enfin le critere
  qu'on cherche : est-ce que l'oiseau revient ?

  COUT : 16 pays x 7 annees = 112 requetes, environ 9 minutes a 5 s d'intervalle.
  Les fichiers sont jetables une fois le comptage fait (voir compter-annees-presence.mjs).

  /barchartData exige une session authentifiee : il faut le cookie complet d'un compte
  eBird connecte (cf. l'en-tete de download-bar-charts-regional.mjs).

  Usage : EBIRD_COOKIE="..." node tools/build/download-bar-charts-par-annee.mjs [CC ...]
*/
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'ebird-barcharts-annees');
mkdirSync(OUT_DIR, { recursive: true });

const PAYS = ['FR', 'ME', 'ES', 'IT', 'GB', 'PT', 'CH', 'NO', 'GR', 'IS', 'LK', 'NA', 'AU', 'NZ', 'US', 'CA'];
const ANNEES = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

const demandes = process.argv.slice(2).filter(a => /^[A-Za-z]{2}$/.test(a)).map(a => a.toUpperCase());
const cibles = demandes.length ? PAYS.filter(c => demandes.includes(c)) : PAYS;

const COOKIE = process.env.EBIRD_COOKIE;
if (!COOKIE) {
  console.error('ERREUR : variable EBIRD_COOKIE non definie.');
  console.error('Usage : EBIRD_COOKIE="..." node tools/build/download-bar-charts-par-annee.mjs');
  process.exit(1);
}

const SLEEP_MS = 5000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cookieJar = {};
(COOKIE.includes('=') ? COOKIE : `EBIRD_SESSIONID=${COOKIE}`).split(';').forEach(kv => {
  const [k, ...reste] = kv.trim().split('=');
  if (k && reste.length) cookieJar[k] = reste.join('=');
});
const cookieHeader = () => Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
function majJar(headers) {
  const arr = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const brut of arr) {
    const [k, ...reste] = brut.split(';')[0].split('=');
    if (k && reste.length) cookieJar[k.trim()] = reste.join('=').trim();
  }
}

function url(cc, an) {
  const p = new URLSearchParams({ byr: String(an), eyr: String(an), bmo: '1', emo: '12', r: cc, fmt: 'tsv' });
  return `https://ebird.org/barchartData?${p.toString()}`;
}

async function une(cc, an) {
  const out = join(OUT_DIR, `${cc}-${an}.txt`);
  if (existsSync(out)) { console.log(`  SKIP ${cc} ${an}`); return 'skip'; }
  try {
    const r = await fetch(url(cc, an), {
      headers: {
        'Cookie': cookieHeader(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
        'Referer': `https://ebird.org/barchart?r=${cc}`,
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-User': '?1',
      },
      redirect: 'follow',
    });
    majJar(r.headers);
    if (!r.ok) { console.error(`  ERREUR ${cc} ${an} : HTTP ${r.status}`); return 'err'; }
    const texte = await r.text();
    // Un TSV valide porte la ligne "Sample Size" et des dizaines de lignes tabulees.
    const lignes = texte.split(/\r?\n/).filter(l => l.includes('\t'));
    if (!/sample size/i.test(texte) || lignes.length < 20) {
      console.error(`  CONTENU SUSPECT ${cc} ${an} (${lignes.length} lignes) — cookie expire ?`);
      return 'invalide';
    }
    writeFileSync(out, texte);
    console.log(`  OK ${cc} ${an} : ${lignes.length} lignes`);
    return 'ok';
  } catch (err) {
    console.error(`  ERREUR ${cc} ${an} : ${err.message}`);
    return 'err';
  }
}

console.log(`${cibles.length} pays x ${ANNEES.length} annees = ${cibles.length * ANNEES.length} requetes, ~${Math.round(cibles.length * ANNEES.length * SLEEP_MS / 60000)} min.\n`);
let ok = 0, err = 0;
for (const cc of cibles) {
  console.log(`=== ${cc} ===`);
  for (const an of ANNEES) {
    const r = await une(cc, an);
    if (r === 'ok') ok++; else if (r === 'err') err++;
    if (r === 'invalide') {
      console.error('\nARRET : le cookie est probablement expire. Refaire un "Copy as cURL" depuis ebird.org.');
      process.exit(1);
    }
    if (r !== 'skip') await sleep(SLEEP_MS);
  }
}
console.log(`\n${ok} fichiers telecharges, ${err} erreurs. Dossier : ${OUT_DIR}`);
console.log('Etape suivante : node tools/build/compter-annees-presence.mjs');
