#!/usr/bin/env node
/*
  filter-ghost-species-fr.mjs

  Post-processing sur real-rarity.generated.js : retire les especes "fantomes"
  (tier 8-10 en France ET 0 obs GBIF recente 2020-2025).

  Rationale : le bareme eBird donne tier 8-10 aux especes avec quelques records
  historiques FR (accidentelles US, africaines, asiatiques...). Mais elles ne
  sont plus observees depuis des annees et n'ont rien a faire dans le quiz /
  classement. Les vagrants legitimes (accepts CAF regulierement) ont eux des
  obs GBIF recentes et restent inclus.

  Sortie :
  - data/generated/real-rarity.generated.js (mise a jour)
  - tools/build/ghost-species-audit.json (log detaille des exclusions)

  Usage :
    node tools/build/filter-ghost-species-fr.mjs
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const RARITY_JS = path.join(ROOT, 'data', 'generated', 'real-rarity.generated.js');
const APP_JS = path.join(ROOT, 'app.js');
const AUDIT_OUT = path.join(__dir, 'ghost-species-audit.json');

// Lit REAL_RARITY courant
const rarityContent = fs.readFileSync(RARITY_JS, 'utf-8');
const rarity = eval('(' + rarityContent.match(/\{[^;]+\}/)[0] + ')');
console.log(`REAL_RARITY : ${Object.keys(rarity).length} especes actuellement.`);

// FR_NAMES pour les labels dans l'audit
const appContent = fs.readFileSync(APP_JS, 'utf-8');
const frNames = eval('(' + appContent.match(/const FR_NAMES\s*=\s*(\{[^;]+\});/)[1] + ')');

// EXOTIQUES_CONNUES_FR : on skip les exotiques (deja gerees separement)
const exotics = eval('(' + appContent.match(/const EXOTIQUES_CONNUES_FR=(\{[^;]+\});/)[1] + ')');

// Candidates : tier 8-10, non exotique. On ne touche PAS les tier 1-7 (esp regulieres/vagrants freq).
const candidates = Object.keys(rarity).filter(sci =>
  rarity[sci] >= 8 && !exotics[sci]
);
console.log(`Candidats fantomes a verifier (tier 8-10 non exotiques) : ${candidates.length}`);

const RATE_MS = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch GBIF species/match (pour obtenir usageKey, en respectant les synonymes)
async function gbifMatch(sci){
  try{
    const r = await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}`);
    if(!r.ok) return null;
    const j = await r.json();
    if(j.matchType !== 'EXACT' && j.matchType !== 'FUZZY') return null;
    // usageKey si SYNONYM (fix critique deja applique cote client)
    if(j.status === 'SYNONYM' && j.usageKey) return j.usageKey;
    return j.speciesKey || j.usageKey || null;
  }catch(_){ return null; }
}

// Fetch GBIF occurrence count for taxonKey in FR sur 5 dernieres annees (2020-2025)
async function gbifRecentCount(taxonKey){
  try{
    const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${taxonKey}&country=FR&year=2020,2025&hasCoordinate=true&limit=0`;
    const r = await fetch(url);
    if(!r.ok) return -1;
    const j = await r.json();
    return typeof j.count === 'number' ? j.count : -1;
  }catch(_){ return -1; }
}

const audit = [];   // { sci, name, tier, gbifKey, recentCount, ghost }
let done = 0;
for(let i = 0; i < candidates.length; i += 8){
  const batch = candidates.slice(i, i + 8);
  const results = await Promise.all(batch.map(async sci => {
    const key = await gbifMatch(sci);
    if(!key) return { sci, tier: rarity[sci], name: frNames[sci]||'?', gbifKey: null, recentCount: -1, ghost: false, note: 'no gbif key' };
    await sleep(RATE_MS);
    const count = await gbifRecentCount(key);
    const ghost = count === 0;   // 0 obs recente FR = fantome
    return { sci, tier: rarity[sci], name: frNames[sci]||'?', gbifKey: key, recentCount: count, ghost };
  }));
  audit.push(...results);
  done += batch.length;
  if(done % 40 === 0 || done === candidates.length){
    const ghosts = audit.filter(a => a.ghost).length;
    console.log(`${done}/${candidates.length} verifies, ${ghosts} fantomes trouves`);
  }
  await sleep(RATE_MS);
}

const ghosts = audit.filter(a => a.ghost);
console.log(`\n=== ${ghosts.length} FANTOMES a exclure ===\n`);
ghosts.sort((a,b) => a.tier - b.tier || a.sci.localeCompare(b.sci));
for(const g of ghosts){
  console.log(`  tier ${g.tier}  ${g.sci.padEnd(38)} ${g.name}`);
}

// Ecrit l'audit complet
fs.writeFileSync(AUDIT_OUT, JSON.stringify(audit, null, 2));
console.log(`\nAudit detaille : ${AUDIT_OUT}`);

// Retire les fantomes de REAL_RARITY et reecrit le fichier
const filtered = {};
for(const sci in rarity){
  if(!ghosts.find(g => g.sci === sci)) filtered[sci] = rarity[sci];
}
const before = Object.keys(rarity).length;
const after = Object.keys(filtered).length;
console.log(`\nREAL_RARITY : ${before} -> ${after} (${before - after} exclusions)`);

fs.writeFileSync(RARITY_JS, 'const REAL_RARITY = ' + JSON.stringify(filtered) + ';\n');
console.log(`Mise a jour : ${RARITY_JS}`);
