#!/usr/bin/env node
/*
  aggregate-au-national.mjs - Reconstruit un bar chart national synthetique AU
  a partir des 8 bar charts regionaux, par moyenne ponderee par sample size.

  Necessaire parce que eBird refuse de generer le bar chart pays entier pour AU
  (dataset trop gros, page "Oups!"). L'aggregation regionale donne un equivalent
  fidele au national pour alimenter REAL_RARITY_AU_EBIRD.

  Sortie : tools/ebird-barcharts-raw/ebird-barchart-AU-2019-2026.txt (format TSV identique).
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const BAR_DIR = join(__dir, '..', 'ebird-barcharts-raw');
const REGIONS = ['AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA'];
const OUT = join(BAR_DIR, 'ebird-barchart-AU-2019-2026.txt');

// Parse un fichier bar chart : renvoie { sampleSize:[48], species: { name: [48] } }
function parseBarchart(path){
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let sampleSize = null;
  const species = {};
  for(const ln of lines){
    if(!ln.includes('\t')) continue;
    const p = ln.split('\t');
    const nm = p[0].trim();
    const nums = p.slice(1).map(Number).filter(x => !isNaN(x));
    if(/sample size/i.test(nm)){
      sampleSize = nums.slice(0, 48);
      continue;
    }
    if(!nm || nums.length < 48) continue;
    species[nm] = nums.slice(0, 48);
  }
  return { sampleSize, species };
}

console.log('Aggregation AU national depuis 8 regions...');
const parsed = {};
let missing = 0;
for(const r of REGIONS){
  const p = join(BAR_DIR, `ebird-barchart-${r}-2019-2026.txt`);
  if(!existsSync(p)){
    console.warn(`  MANQUE : ${r}`);
    missing++;
    continue;
  }
  parsed[r] = parseBarchart(p);
  console.log(`  ${r} : ${Object.keys(parsed[r].species).length} sp, sample size max ${Math.max(...parsed[r].sampleSize)}`);
}
if(missing > 0){
  console.error(`ARRET : ${missing} regions manquantes, aggregation impossible.`);
  process.exit(1);
}

// Somme des sample sizes par quinzaine
const totalSample = new Array(48).fill(0);
for(const r of REGIONS){
  for(let q = 0; q < 48; q++) totalSample[q] += parsed[r].sampleSize[q] || 0;
}

// Union des especes + freq ponderee
const allSpecies = new Set();
for(const r of REGIONS) for(const sp of Object.keys(parsed[r].species)) allSpecies.add(sp);

const aggregated = {};
for(const sp of allSpecies){
  const freqs = new Array(48).fill(0);
  for(let q = 0; q < 48; q++){
    let weighted = 0;
    for(const r of REGIONS){
      const s = parsed[r].sampleSize[q] || 0;
      const f = (parsed[r].species[sp] || [])[q] || 0;
      weighted += f * s;
    }
    freqs[q] = totalSample[q] > 0 ? weighted / totalSample[q] : 0;
  }
  aggregated[sp] = freqs;
}

console.log(`\nTotal : ${allSpecies.size} especes uniques agregees, sample size max ${Math.max(...totalSample)}`);

// Ecrit le TSV au format eBird
const monthCols = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const header1 = 'Frequency of observations in the selected location(s).:';
const taxa = `Number of taxa: \t${allSpecies.size}`;
const monthRow = '\t' + monthCols.map(m => `${m}\t\t\t\t`).join('').trimEnd();
const sampleRow = 'Sample Size:\t' + totalSample.map(s => s.toFixed(1)).join('\t');

// Format eBird : freqs en notation scientifique ou decimale
function fmt(v){
  if(v === 0) return '0.0';
  if(v < 1e-3) return v.toExponential(3).replace('e-0', 'E-').replace('e-', 'E-');
  return (+v.toFixed(7)).toString();
}

const speciesRows = [];
for(const [sp, freqs] of Object.entries(aggregated)){
  speciesRows.push(sp + '\t' + freqs.map(fmt).join('\t'));
}

const content = [header1, '', taxa, '', monthRow, sampleRow, ...speciesRows, ''].join('\n');
writeFileSync(OUT, content);
console.log(`\nEcrit : ${OUT} (${content.length} bytes)`);
