#!/usr/bin/env node
/*
  build-redlist.mjs — Extrait la Liste rouge de France (UICN France) des oiseaux
  depuis les articles Wikipédia (mêmes sources que FR_NAMES), qui reprennent les
  statuts officiels INPN par population (nicheur / hivernant / de passage).

  On retient en priorité le statut NICHEUR ({{NI}}), le plus pertinent pour la
  patrimonialité d'une espèce en France ; sinon le premier statut France dispo.

  Codes : LC, NT, VU, EN, CR (menace croissante), RE (disparu), NAa/NAb/NAc/NAd
  (non applicable : marginal/occasionnel), DD (data deficient), NE (non évalué).

  Sortie : tools/redlist.json  ->  { "<sci minuscule>": { fr:"VU", global:"LC" }, ... }
  Usage : node tools/build-redlist.mjs
*/
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

const PAGES = ['Liste des oiseaux en France métropolitaine', 'Liste des passereaux en France métropolitaine'];

async function wikitext(page) {
  const url = 'https://fr.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&page=' + encodeURIComponent(page);
  const r = await fetch(url, { headers: { 'User-Agent': 'ligue-merlin/1.0 (redlist build)' } });
  const j = await r.json();
  return (j.parse && j.parse.wikitext) || '';
}

function parseRows(w, out) {
  const rows = w.split(/\n\|-/);
  for (const row of rows) {
    // nom scientifique : premier binôme latin en italique (''...'' éventuellement [[lié]])
    const sm = row.match(/''(?:\[\[(?:[^\]|]*\|)?)?([A-ZÀ-Ÿ][a-zà-ÿ-]+ [a-zà-ÿ-]+)/);
    if (!sm) continue;
    const sci = sm[1].trim().toLowerCase();
    // statut France : nicheur en priorité, sinon premier statut France
    const ni = row.match(/\{\{NI\}\}\s*\{\{Icône UICN France\|([A-Za-z]+)\}\}/i);
    const anyFr = row.match(/\{\{Icône UICN France\|([A-Za-z]+)\}\}/i);
    const glob = row.match(/\{\{Icône UICN\|([A-Za-z]+)\}\}/i);
    const fr = ni ? ni[1] : (anyFr ? anyFr[1] : null);
    if (!fr && !glob) continue;
    if (!out[sci]) out[sci] = { fr: fr || null, global: glob ? glob[1] : null };
  }
}

(async () => {
  const out = {};
  for (const p of PAGES) { parseRows(await wikitext(p), out); }
  writeFileSync(join(__dir, 'redlist.json'), JSON.stringify(out, null, 0));
  const vals = Object.values(out);
  const dist = {};
  vals.forEach(v => { dist[v.fr || 'null'] = (dist[v.fr || 'null'] || 0) + 1; });
  console.log('Espèces avec statut :', vals.length);
  console.log('Répartition (nicheur France) :', JSON.stringify(dist));
  console.log('\nVérifs :');
  ['vanellus vanellus','emberiza hortulana','turdus merula','crex crex','tetrax tetrax','burhinus oedicnemus','passer domesticus','pyrrhula pyrrhula','alauda arvensis','coturnix coturnix'].forEach(s =>
    console.log('  '+s.padEnd(24)+' France='+(out[s]?out[s].fr:'?')+'  monde='+(out[s]?out[s].global:'?')));
})();
