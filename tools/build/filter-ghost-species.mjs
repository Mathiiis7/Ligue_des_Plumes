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
const APP_JS = path.join(ROOT, 'app.js');
// Config des pays : chaque entree = { code, rarityFile, minTier }.
// minTier : on ne verifie que les especes >= ce tier (les plus communes ont trop d'obs
// eBird pour etre fantomes, tester des Colombes/Corneilles serait perte d'API calls).
// Seuil GBIF : nb minimum d'obs recentes (2020-2025) pour ne PAS etre fantome.
// 3 = elimine les erreurs d'ID isolees et vraies megararetes '1 obs', garde vagrants
// recurrents (>= 1/an). Pour FR uniquement : double filtre = espece sauvee si eBird
// bar chart l'a (evite d'exclure a tort vagrants taxonomiquement splittes comme
// anas carolinensis roule dans crecca cote eBird).
const GBIF_MIN_OBS = 3;
const COUNTRIES = [
  { code: 'FR', file: 'data/generated/real-rarity.generated.js', minTier: 7, ebirdSourceFile: 'data/generated/rarity-data-ebird.json' },
  { code: 'ES', file: 'data/generated/real-rarity-es-ebird.generated.js', minTier: 7 },
  { code: 'IT', file: 'data/generated/real-rarity-it-ebird.generated.js', minTier: 7 },
  { code: 'GB', file: 'data/generated/real-rarity-gb-ebird.generated.js', minTier: 7 },
  { code: 'PT', file: 'data/generated/real-rarity-pt-ebird.generated.js', minTier: 7 },
  { code: 'ME', file: 'data/generated/real-rarity-me-ebird.generated.js', minTier: 7 },
];
const AUDIT_OUT = path.join(__dir, 'ghost-species-audit.json');

const appContent = fs.readFileSync(APP_JS, 'utf-8');
const frNames = eval('(' + appContent.match(/const FR_NAMES\s*=\s*(\{[^;]+\});/)[1] + ')');
const exotics = eval('(' + appContent.match(/const EXOTIQUES_CONNUES_FR=(\{[^;]+\});/)[1] + ')');

const RATE_MS = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cache global des matches GBIF (evite de re-query si plusieurs pays scannent la meme espece)
const gbifKeyCache = new Map();

// Fetch GBIF species/match (pour obtenir usageKey, en respectant les synonymes). Cache.
async function gbifMatch(sci){
  if(gbifKeyCache.has(sci)) return gbifKeyCache.get(sci);
  try{
    const r = await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sci)}`);
    if(!r.ok){ gbifKeyCache.set(sci, null); return null; }
    const j = await r.json();
    if(j.matchType !== 'EXACT' && j.matchType !== 'FUZZY'){ gbifKeyCache.set(sci, null); return null; }
    const key = (j.status === 'SYNONYM' && j.usageKey) ? j.usageKey : (j.speciesKey || j.usageKey || null);
    gbifKeyCache.set(sci, key);
    return key;
  }catch(_){ gbifKeyCache.set(sci, null); return null; }
}

// Fetch GBIF occurrence count for taxonKey in <country> sur 5 dernieres annees (2020-2025)
async function gbifRecentCount(taxonKey, country){
  try{
    const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${taxonKey}&country=${country}&year=2020,2025&hasCoordinate=true&limit=0`;
    const r = await fetch(url);
    if(!r.ok) return -1;
    const j = await r.json();
    return typeof j.count === 'number' ? j.count : -1;
  }catch(_){ return -1; }
}

// Process une entree pays : lit son fichier, scan candidates tier >= minTier,
// requete GBIF pour le pays, retire les fantomes, reecrit le fichier.
// Double filtre pour FR (ebirdSourceFile): sauve les especes qui ont un vrai
// freq eBird (source != 'gbif-fallback'), meme si peu d'obs GBIF.
async function processCountry(cfg){
  const rarityFile = path.join(ROOT, cfg.file);
  if(!fs.existsSync(rarityFile)){ console.log(`[${cfg.code}] SKIP fichier absent : ${cfg.file}`); return { code: cfg.code, ghosts: [] }; }
  const content = fs.readFileSync(rarityFile, 'utf-8');
  const rarity = eval('(' + content.match(/\{[^;]+\}/)[0] + ')');
  // Charge le tableau source eBird si dispo (FR uniquement pour l'instant)
  let ebirdSources = null;
  if(cfg.ebirdSourceFile){
    const src = path.join(ROOT, cfg.ebirdSourceFile);
    if(fs.existsSync(src)){
      const arr = JSON.parse(fs.readFileSync(src, 'utf-8'));
      ebirdSources = new Map(arr.map(r => [r.sci, r.source]));
    }
  }
  const candidates = Object.keys(rarity).filter(sci => rarity[sci] >= cfg.minTier && !exotics[sci]);
  console.log(`\n[${cfg.code}] ${Object.keys(rarity).length} especes total, ${candidates.length} candidats tier >= ${cfg.minTier}${ebirdSources ? ' (double filtre eBird actif)' : ''}`);
  const results = [];
  let done = 0;
  for(let i = 0; i < candidates.length; i += 8){
    const batch = candidates.slice(i, i + 8);
    const res = await Promise.all(batch.map(async sci => {
      const key = await gbifMatch(sci);
      if(!key) return { sci, tier: rarity[sci], name: frNames[sci]||'?', gbifKey: null, recentCount: -1, ghost: false, note: 'no gbif key' };
      await sleep(RATE_MS);
      const count = await gbifRecentCount(key, cfg.code);
      // Fantome si GBIF < seuil MIN. Save si eBird a un freq (source != gbif-fallback).
      let ghost = count >= 0 && count < GBIF_MIN_OBS;
      let savedBy = null;
      if(ghost && ebirdSources){
        const src = ebirdSources.get(sci);
        if(src && src !== 'gbif-fallback'){ ghost = false; savedBy = 'ebird-' + src; }
      }
      return { sci, tier: rarity[sci], name: frNames[sci]||'?', gbifKey: key, recentCount: count, ghost, savedBy };
    }));
    results.push(...res);
    done += batch.length;
    if(done % 40 === 0 || done === candidates.length){
      const gN = results.filter(a => a.ghost).length;
      const sv = results.filter(a => a.savedBy).length;
      console.log(`  [${cfg.code}] ${done}/${candidates.length} verifies, ${gN} fantomes${sv ? ` (${sv} sauves par eBird)` : ''}`);
    }
    await sleep(RATE_MS);
  }
  const ghosts = results.filter(r => r.ghost);
  // Ecrit le fichier filtre : preserve le nom de constante (REAL_RARITY, REAL_RARITY_ES_EBIRD, etc.)
  const constNameMatch = content.match(/const\s+(\w+)\s*=/);
  const constName = constNameMatch ? constNameMatch[1] : 'REAL_RARITY';
  const filtered = {};
  for(const sci in rarity){ if(!ghosts.find(g => g.sci === sci)) filtered[sci] = rarity[sci]; }
  fs.writeFileSync(rarityFile, `const ${constName} = ${JSON.stringify(filtered)};\n`);
  console.log(`  [${cfg.code}] ${Object.keys(rarity).length} -> ${Object.keys(filtered).length} (${ghosts.length} exclusions)`);
  return { code: cfg.code, ghosts, before: Object.keys(rarity).length, after: Object.keys(filtered).length };
}

const summary = {};
for(const cfg of COUNTRIES){
  const r = await processCountry(cfg);
  summary[r.code] = r;
}

// Audit global consolide
const audit = {};
for(const code in summary){ audit[code] = summary[code].ghosts; }
fs.writeFileSync(AUDIT_OUT, JSON.stringify(audit, null, 2));

console.log('\n=== RESUME ===');
for(const code in summary){
  const s = summary[code];
  console.log(`  ${code} : ${s.before || '?'} -> ${s.after || '?'} (${s.ghosts.length} fantomes)`);
}
console.log(`\nAudit detaille : ${AUDIT_OUT}`);
