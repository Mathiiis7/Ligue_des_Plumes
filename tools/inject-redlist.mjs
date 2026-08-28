#!/usr/bin/env node
/*
  inject-redlist.mjs , Injecte tools/redlist.json dans index.html en remplacant
  la constante REDLIST inline.

  Usage : node tools/inject-redlist.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const HTML = join(ROOT, 'index.html');
const RL = join(__dir, 'redlist.json');

let html = readFileSync(HTML, 'utf8');
const rl = readFileSync(RL, 'utf8');
const start = html.indexOf('const REDLIST = ');
if (start < 0) { console.error('REDLIST introuvable dans index.html'); process.exit(1); }
const bs = html.indexOf('{', start);
let depth = 0, inStr = false, esc = false, ei = -1;
for (let i = bs; i < html.length; i++) {
  const c = html[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (c === '"') { inStr = !inStr; continue; }
  if (inStr) continue;
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { ei = i; break; } }
}
const si = html.indexOf(';', ei);
const before = html.length;
html = html.slice(0, start) + 'const REDLIST = ' + rl + ';' + html.slice(si + 1);
writeFileSync(HTML, html);
const nEntries = Object.keys(JSON.parse(rl)).length;
console.log(`OK. REDLIST : ${nEntries} especes.`);
console.log(`index.html : ${before} , ${html.length} (${html.length - before > 0 ? '+' : ''}${html.length - before} bytes)`);
