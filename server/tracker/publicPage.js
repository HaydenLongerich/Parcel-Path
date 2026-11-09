// Fallback used only when no API key is configured. See canadaPost.js for the main path.
//
// A headless browser opens the public tracking page and we read the JSON that page
// receives. Direct HTTP calls to the endpoint return 403, because the page sends a
// login built into its own code; we deliberately do not copy or reuse that login.
// We also do not disguise the browser or solve CAPTCHAs: if the site blocks us, the
// user sees a clear error.
import { TrackingError } from './common.js';

const PAGE_BASE = 'https://www.canadapost-postescanada.ca/track-reperage/en';
const SUMMARY_PATH = '/track/json/package?pins=';
const DETAIL_PATH = (pin) => `/track/json/package/${pin}/detail`;
const NAVIGATION_TIMEOUT_MS = 45_000;
const DATA_TIMEOUT_MS = 30_000;

const clean = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
};

function parseEvent(event) {
  if (!event || typeof event !== 'object' || !event.datetime?.date) {
    throw new TrackingError('format_changed', 'A scan event was missing its date.');
  }
  const location = event.locationAddr ?? {};
  return {
    date: event.datetime.date,
    time: clean(event.datetime.time)?.slice(0, 5) ?? null,
    description: clean(event.descEn) ?? clean(event.descFr) ?? 'Scan recorded',
    city: clean(location.city),
    region: clean(location.regionCd)?.toUpperCase() ?? null,
    postalCode: clean(location.postalCode ?? location.postalCd ?? location.postalZipCode),
    country: clean(location.countryCd)?.toUpperCase() ?? null,
  };
}

function parseDestination(raw) {
  const address = raw.destAddr ?? raw.destinationAddr ?? raw.deliveryAddr ?? raw.dlvryAddr;
  const postalCode = clean(address?.postalCode ?? raw.destPostalCode ?? raw.destinationPostalCode);
  const city = clean(address?.city ?? raw.destCity);
  if (!postalCode && !city) return null;
  return { city, region: clean(address?.regionCd ?? raw.destRegionCd), postalCode };
}

const STATUS_LABELS = {
  Delivered: 'Delivered',
  HalfAccepted: 'Accepted',
  FullProgressAlert: 'Delivery notice',
};

/** Converts Canada Post's detail JSON into this app's format. Exported for tests. */
export function parseDetail(raw, pin) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) {
    throw new TrackingError('format_changed', 'The tracking response no longer contains a list of scan events.');
  }
  if (raw.error) {
    throw new TrackingError('not_found', raw.error.descEn || 'Canada Post has no record of this number.');
  }
  const events = raw.events.map(parseEvent).sort((a, b) =>
    `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`),
  );
  const delivered = raw.delivered === true || Boolean(raw.actualDlvryDate) || String(raw.status) === 'Delivered';
  const latest = events.at(-1);
  return {
    pin: clean(raw.pin) ?? pin,
    service: clean(raw.productNmEn) ?? clean(raw.serviceType),
    status: delivered ? 'Delivered' : (STATUS_LABELS[raw.status] ?? latest?.description ?? 'Unknown'),
    delivered,
    expectedDelivery:
      clean(raw.actualDlvryDate) ??
      clean(raw.expectedDlvryDateTime?.revisedDate) ??
      clean(raw.expectedDlvryDateTime?.dlvryDate) ??
      clean(raw.deliveryStandardDate),
    destination: parseDestination(raw),
    events,
  };
}

/** Reads the first summary response: throws if Canada Post reported an error for the PIN. */
export function checkSummary(summary) {
  if (!Array.isArray(summary) || summary.length === 0) {
    throw new TrackingError('format_changed', 'The tracking summary response has an unexpected format.');
  }
  const error = summary[0].error;
  if (error) {
    throw new TrackingError('not_found', 'Canada Post has no tracking history for this number. Check the number, or try again once the item has been scanned.');
  }
}

async function launchBrowser() {
  let playwright;
  try {
    playwright = await import('playwright');
    return await playwright.chromium.launch({ headless: true });
  } catch (cause) {
    throw new TrackingError('unavailable', `The headless browser could not start. Run "npm run setup:browser". (${cause.message.split('\n')[0]})`);
  }
}

async function scrape(pin) {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ locale: 'en-CA' });
    const page = await context.newPage();

    // Visuals are not needed, so skip them and put less load on the site.
    await page.route('**/*', (route) =>
      ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue(),
    );

    let settle;
    let fail;
    const result = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    result.catch(() => {});

    page.on('response', async (response) => {
      const url = response.url();
      const isSummary = url.includes(SUMMARY_PATH);
      const isDetail = url.includes(DETAIL_PATH(pin));
      if (!isSummary && !isDetail) return;
      try {
        if (response.status() === 403 || response.status() === 429) {
          throw new TrackingError('blocked', `Canada Post refused the tracking request (HTTP ${response.status()}).`);
        }
        if (response.status() >= 500) {
          throw new TrackingError('unavailable', `Canada Post's tracking service returned HTTP ${response.status()}.`);
        }
        if (isDetail && response.status() === 404) {
          throw new TrackingError('not_found', 'Canada Post has no tracking history for this number.');
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new TrackingError('format_changed', 'The tracking response was not valid JSON.');
        }
        if (isSummary) checkSummary(body);
        else settle(parseDetail(body, pin));
      } catch (error) {
        fail(error);
      }
    });

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        const captcha = await page.locator('iframe[src*="recaptcha/api2/bframe"]:visible').count().catch(() => 0);
        reject(
          captcha
            ? new TrackingError('blocked', 'Canada Post asked for a CAPTCHA. This app does not solve them; open the tracking page in your own browser.')
            : new TrackingError('format_changed', 'The tracking page loaded, but the expected data request never happened.'),
        );
      }, DATA_TIMEOUT_MS);
    });

    try {
      await page.goto(`${PAGE_BASE}/search?searchFor=${encodeURIComponent(pin)}&searchBy=PIN`, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (cause) {
      throw new TrackingError('unavailable', `The Canada Post tracking page could not be opened. (${cause.message.split('\n')[0]})`);
    }

    try {
      return await Promise.race([result, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await browser.close();
  }
}

// One browser at a time, however many requests arrive.
let queue = Promise.resolve();

export function fetchFromPublicPage(pin) {
  const run = queue.then(() => scrape(pin));
  queue = run.catch(() => {});
  return run;
}
