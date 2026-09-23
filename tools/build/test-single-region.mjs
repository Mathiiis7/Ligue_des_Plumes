import { chromium } from 'playwright';

const REGION = process.argv[2] || 'FR-IDF-94';
const url = `https://ebird.org/barchart?r=${REGION}&byr=1900&eyr=2026`;

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'fr-FR',
});
const page = await ctx.newPage();

console.log(`Navigating to ${url}...`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
try {
  await page.waitForSelector('.SpeciesName', { timeout: 25000 });
} catch(e) {
  console.warn('No .SpeciesName after 25s');
}
await page.waitForTimeout(3000);

const data = await page.evaluate(() => {
  const out = [];
  const rows = document.querySelectorAll('.SpeciesName');
  for (const row of rows) {
    const link = row.querySelector('a[data-species-code]');
    if (!link) continue;
    const code = link.getAttribute('data-species-code');
    const name = link.textContent.trim();
    const icon = row.querySelector('[class*="Icon--exotic"]');
    let cat = null;
    if (icon) {
      const classes = [...(icon.classList || [])];
      if (classes.some(c => c.includes('Naturalized'))) cat = 'N';
      else if (classes.some(c => c.includes('Provisional'))) cat = 'P';
      else if (classes.some(c => c.includes('Escapee'))) cat = 'X';
    }
    if (name.toLowerCase().includes('cygne')) out.push({ code, name, cat });
  }
  return out;
});

console.log(`\n=== Résultats ${REGION} ===`);
for (const r of data) console.log(`  ${r.code} - ${r.name} : ${r.cat || 'sauvage/non-listé'}`);

await browser.close();
