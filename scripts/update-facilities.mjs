// Refreshes the FSA ranges in server/data/facilities.json from Canada Post's public table.
// Coordinates, scan names and IDs are left alone. Nothing is written unless all 21 rows match.
//
//   npm run update:facilities                    downloads the official page
//   npm run update:facilities -- saved-page.html  uses a page you saved from your browser
import { readFile, writeFile } from 'node:fs/promises';
import { parseFacilityTable } from './parseFacilityTable.mjs';

const dataUrl = new URL('../server/data/facilities.json', import.meta.url);

async function loadPage(source, localFile) {
  if (localFile) return readFile(localFile, 'utf8');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(source, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response?.ok()) {
      throw new Error(`Canada Post returned HTTP ${response?.status()}. Save the page from your browser and pass its path to this script.`);
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function main() {
  const data = JSON.parse(await readFile(dataUrl, 'utf8'));
  const rows = parseFacilityTable(await loadPage(data.source, process.argv[2]));

  if (rows.length !== data.facilities.length) {
    throw new Error(`Expected ${data.facilities.length} table rows, found ${rows.length}. The page layout may have changed; nothing written.`);
  }

  const claimed = new Set();
  for (const facility of data.facilities) {
    const row = rows.find((r) => r.name.startsWith(facility.tableName) && !claimed.has(r));
    if (!row || row.major.length + row.nonMajor.length === 0) {
      throw new Error(`No usable table row for "${facility.tableName}"; nothing written.`);
    }
    claimed.add(row);
    facility.fsa = { major: row.major, nonMajor: row.nonMajor };
  }

  data.updated = new Date().toISOString().slice(0, 10);

  // One facility per line keeps hand edits and diffs readable.
  const { facilities, ...header } = data;
  const lines = facilities.map((f) => `    ${JSON.stringify(f)}`).join(',\n');
  const headerJson = JSON.stringify(header, null, 2).replace(/\n}$/, '');
  await writeFile(dataUrl, `${headerJson},\n  "facilities": [\n${lines}\n  ]\n}\n`);
  console.log(`Updated ${facilities.length} facilities.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
