#!/usr/bin/env node
/*
  build-avonet-traits.mjs - Extrait ecologie + morphologie Avonet pour affichage
  sur les fiches especes.

  Source : tools/avonet.xlsx, sheet AVONET2_eBird
  Sortie : data/avonet_traits.json (~1.4 MB, lazy load cote app)

  Structure par espece :
    {
      hd: 1|2|3,            // Habitat.Density (1=dense, 3=ouvert)
      mi: 1|2|3,            // Migration (1=sedentaire, 3=migrateur total)
      tl: 'C'|'H'|'O'|'S',  // Trophic Level (Carnivore/Herbivore/Omnivore/Scavenger)
      tn: 'Insectivore',... // Trophic Niche
      pl: 'Ins'|'Aer'|...,  // Primary Lifestyle (3 char)
      ma: 12.5,             // Mass (g)
      wi: 66,                // Wing.Length (mm)
      bl: 8.5,               // Beak.Length_Culmen (mm)
      ta: 16.3,              // Tarsus.Length (mm)
      tail: 51,              // Tail.Length (mm)
      hwi: 15.7,             // Hand-Wing.Index (dispersion)
    }

  Usage : node tools/build-avonet-traits.mjs
*/
import XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const XLSX_PATH = join(__dir, 'avonet.xlsx');
const OUT_PATH = join(ROOT, 'data', 'avonet_traits.json');

console.log('[1] Lecture Avonet xlsx (AVONET2_eBird)...');
const wb = XLSX.readFile(XLSX_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['AVONET2_eBird']);
console.log(`    ${rows.length} lignes.`);

console.log('\n[2] Extraction des traits...');
const out = {};
let n = 0;
for (const r of rows) {
  const sci = String(r.Species2 || '').trim().toLowerCase();
  if (!sci) continue;
  // Round numeric fields to 1 decimal to reduce size and cleaner display
  const round1 = v => (v == null || isNaN(v)) ? null : Math.round(v * 10) / 10;
  const rec = {
    hd: Number(r['Habitat.Density']) || null,
    mi: Number(r.Migration) || null,
    tl: (r['Trophic.Level'] || '').charAt(0) || null,
    tn: r['Trophic.Niche'] || null,
    pl: (r['Primary.Lifestyle'] || '').slice(0, 3) || null,
    ma: round1(Number(r.Mass)),
    wi: round1(Number(r['Wing.Length'])),
    bl: round1(Number(r['Beak.Length_Culmen'])),
    ta: round1(Number(r['Tarsus.Length'])),
    tail: round1(Number(r['Tail.Length'])),
    hwi: round1(Number(r['Hand-Wing.Index'])),
  };
  // Retire les cles null pour reduire la taille
  for (const k of Object.keys(rec)) if (rec[k] == null) delete rec[k];
  if (Object.keys(rec).length === 0) continue;
  out[sci] = rec;
  n++;
}
console.log(`    ${n} especes avec au moins 1 trait.`);

console.log('\n[3] Ecriture data/avonet_traits.json...');
writeFileSync(OUT_PATH, JSON.stringify(out));
const stat = (await import('node:fs/promises')).default.stat;
const size = (await stat(OUT_PATH)).size;
console.log(`    OK. ${(size/1024).toFixed(0)} KB.`);
