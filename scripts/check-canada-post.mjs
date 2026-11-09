// Tests your Canada Post API key and real tracking numbers from the command line.
//
//   npm run check:api                               is the key accepted?
//   npm run check:api -- 1234567890123456           show how a real parcel parses
//   npm run check:api -- 1234567890123456 --save delivered
//       also saves a test case to tests/fixtures/, with personal details removed
import '../server/env.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readApiConfig } from '../server/tracker/apiClient.js';
import { fetchRawTracking, parseTracking } from '../server/tracker/canadaPost.js';
import { isValidPin, sanitizePin } from '../server/tracker/common.js';

const FAKE_PIN = '1000000000000000';
const PRIVATE_FIELDS = new Set(['customerRef1', 'customerRef2', 'originalPin', 'returnPin', 'codRemitInfo']);

function anonymize(value) {
  if (Array.isArray(value)) return value.map(anonymize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELDS.has(key))
      .map(([key, item]) => {
        if (key === 'pin') return [key, FAKE_PIN];
        // A full postal code can narrow down to a single block, so keep only the area.
        if (key === 'destinationPostalId') return [key, String(item).slice(0, 3)];
        return [key, anonymize(item)];
      }),
  );
}

async function checkKey(config) {
  try {
    await fetchRawTracking('1000000000000001', { config });
    console.log('Key accepted.');
  } catch (error) {
    if (error.code !== 'not_found' && error.code !== 'invalid_number') throw error;
    console.log('Key accepted (Canada Post answered that a made-up number has no history, as expected).');
  }
}

async function checkParcel(config, pin, saveAs) {
  const raw = await fetchRawTracking(pin, { config });
  console.log(JSON.stringify(parseTracking(raw.detail, raw.summary, pin), null, 2));
  if (saveAs) {
    if (!/^[\w-]+$/.test(saveAs)) throw new Error('Use only letters, numbers, - and _ in the --save name.');
    const directory = new URL('../tests/fixtures/', import.meta.url);
    await mkdir(directory, { recursive: true });
    const fixture = { detail: anonymize(raw.detail), summary: anonymize(raw.summary) };
    await writeFile(new URL(`${saveAs}.json`, directory), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`\nSaved tests/fixtures/${saveAs}.json. Scan locations are kept, so read it before sharing.`);
  }
}

async function main() {
  const config = readApiConfig();
  if (!config) throw new Error('No API key found. Copy .env.example to .env.local and fill it in.');

  const { values, positionals } = parseArgs({ allowPositionals: true, options: { save: { type: 'string' } } });
  const [pinArg] = positionals;
  if (!pinArg) return checkKey(config);

  const pin = sanitizePin(pinArg);
  if (!isValidPin(pin)) throw new Error('That does not look like a tracking number.');
  return checkParcel(config, pin, values.save ?? null);
}

main().catch((error) => {
  console.error(`${error.code ? `[${error.code}] ` : ''}${error.message}`);
  process.exitCode = 1;
});
