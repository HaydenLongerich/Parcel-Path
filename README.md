# Parcel Path

Enter a Canada Post tracking number and see where the parcel has been scanned, where it probably goes next, and a clickable timeline of its scans. You can also price a shipment and compare the likely route for each service. Works in light and dark mode.

This is an independent project, not affiliated with Canada Post. Use it for personal, low-volume lookups.

## Setup

Requires Node 20.12 or newer.

```bash
npm install
```

To track real parcels, add a key from the [Canada Post Developer Portal](https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/):

1. Create a **[Production]** app and add the **Tracking**, **Rating**, **Post Office Services** and **Service Information** products to it. One key covers all four.
2. Copy `.env.example` to `.env.local`.
3. Fill in `CANADA_POST_API_KEY` and `CANADA_POST_API_SECRET` from the app's Credentials section. The secret is shown only once, but can be reset there.
4. Run `npm run check:api` to confirm Canada Post accepts it.

The key stays on the server and `.env.local` is ignored by git. Never put it in a `VITE_` variable, because those are sent to the browser.

Without a key, live lookups fall back to a headless browser on the public tracking page. That needs one more step, which downloads Chromium (about 125 MB):

```bash
npm run setup:browser
```

## Running

| Command | What it does |
| --- | --- |
| `npm run dev` | Development: app at http://localhost:5173, API on port 3001 |
| `npm start` | Builds the app and serves everything at http://127.0.0.1:3001 |
| `npm test` | Runs the unit tests |
| `npm run update:facilities` | Refreshes the FSA table from Canada Post |
| `npm run check:api` | Tests your API key and real tracking numbers |

The app opens on a stored sample parcel (Twillingate, NL to Windsor, ON), and **Show the demo parcel** returns to it. The sample contacts nothing at Canada Post.

### Map

The basemap is [OpenFreeMap](https://openfreemap.org)'s minimal vector style, which needs no key. If you have a free [CARTO key](https://carto.com/basemaps/apikey), add `VITE_CARTO_KEY=your_key_here` to `.env.local` and restart to use CARTO instead. OpenStreetMap raster tiles are only a fallback for browsers without WebGL, because they draw forest cover as blocky patches across northern Canada.

## Features that use your API key

| Feature | Service | Notes |
| --- | --- | --- |
| Live tracking | Tracking | Scans, status, dates, destination |
| Pickup hours | Post Office Services | Shown when a parcel is held at a Post Office |
| More accurate destination | Post Office Services | Places the destination using its closest Post Office |
| On schedule or behind | Rating | Compares the expected date with the service's standard, in business days and ignoring holidays |
| Cost and route estimate | Rating, Post Office Services | Retail prices including fuel and tax |
| Outage banner | Service Information | Shown when Canada Post has scheduled maintenance |

Retail rates don't include **Expedited Parcel**. To add it, and to see your own account rates, set `CANADA_POST_CUSTOMER_NUMBER` in `.env.local`. Without it, the on-time check doesn't appear for Expedited parcels.

### How estimated routes work

Canada Post publishes prices and transit times, but not which services fly. For each service, the app divides the road distance by its transit time. Above 800 km per business day a truck couldn't plausibly keep up, so that service is shown going by road to the nearest air hub, flying to the hub nearest the destination, then by road again. Air hubs are listed in `server/data/network.json`. Treat these routes as estimates.

## How the tracking data is fetched

With a key in `.env.local`, `server/tracker/canadaPost.js` uses Canada Post's [Tracking 2.0.0 API](https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/product/tracking/api/tracking-api-1.0.0). The API Key and Secret are exchanged for a short-lived OAuth token, which is reused until it nears expiry. Responses are JSON.

| Call | Used for |
| --- | --- |
| `GET /tracking/v1/pins/{number}/details` | Scans, service, expected date, changed date and reason, destination postal code |
| `GET /tracking/v1/pins/{number}/summaries` | Delivered and attempted dates, current event type, destination province |

A 15-digit number is treated as a Delivery Notice Card and uses `/dncs/` instead of `/pins/`.

Without a key, `server/tracker/publicPage.js` opens the public tracking page in a headless browser and reads the JSON it receives. The browser is not disguised and CAPTCHAs are not solved. If a key is set, this path is never used, even when the API fails, so problems show up as clear errors.

**Limits on contacting Canada Post:**

- Each parcel is fetched at most once every 15 minutes; requests in between get the cached copy.
- Failed lookups are remembered for 5 minutes, so errors don't cause rapid retries.
- API calls stay under Canada Post's default limit of 20 tracking calls a minute.
- An open page refreshes every 20 minutes and stops once the parcel is delivered.

**Destination:** the API gives the destination's postal code, sometimes only the first three characters, so the last leg ends at that postal area rather than the exact address. International parcels have no predicted route unless you fill in the optional Destination box.

## Testing tracking numbers

Use the **Test bench** at the bottom of the app, or the link in the footer. It looks up to 10 numbers at once and shows the result for each.

| Mode | Key | What it does |
| --- | --- | --- |
| Test app | `CANADA_POST_TEST_API_KEY` and `CANADA_POST_TEST_API_SECRET`, from a **[Test]** app | Returns Canada Post's sample data for any number. **Random numbers** only work here |
| Production key | Your normal key | Looks up real parcels, using numbers you type |

Random numbers never go to your production key, because a random number could match a stranger's parcel.

From the command line:

| Step | Command | Proves |
| --- | --- | --- |
| Key check | `npm run check:api` | Canada Post accepts your key |
| Offline tests | `npm test` | Parsing and error handling |
| Real parcel | `npm run check:api -- <number>` | How a real parcel parses |
| Save a test case | `npm run check:api -- <number> --save delivered` | Adds that response to `npm test` permanently |

Saved cases go in `tests/fixtures/`, with the tracking number, references and related numbers removed, and the destination cut to its first three characters. Scan locations are kept, so read a file before sharing it.

## If it breaks

| Message in the app | Likely cause | What to do |
| --- | --- | --- |
| Check the tracking number | Not 11–16 digits or the `RN123456789CA` style | Fix the number |
| No tracking history found | Unknown number, or not scanned yet | Check it on Canada Post's site |
| Check your Canada Post API key | Wrong key or secret, or a product isn't added to the app | Fix it, restart, and run `npm run check:api` |
| Too many requests | Over Canada Post's per-minute limit | Wait a minute |
| Tracking is unavailable right now | Canada Post or your connection is down | Try later |
| Canada Post blocked the request | Public page only: HTTP 403 or 429, or a CAPTCHA | Add an API key. Do not add workarounds that evade the block |
| Yellow banner with sample data | The API or page response changed | See below |

To fix a format change:

1. Run `npm run check:api -- <number>` and compare the output with what the app shows.
2. Check Canada Post's [release notes](https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/release-notes) and download the latest OpenAPI document from the Tracking page.
3. Update `parseTracking` in `server/tracker/canadaPost.js` and run `npm test`.

## Updating the facility table

The data comes from Canada Post's [Processing facilities for Parcel Services shipping in Canada](https://www.canadapost-postescanada.ca/cpc/en/support/articles/delivery-standards/processing-facilities-parcel-services-shipping-in-canada.page) page and lives in `server/data/facilities.json`.

```bash
npm run update:facilities
```

The script only replaces the FSA ranges, and it writes nothing unless all 21 table rows match. If the download fails, save the page from your browser and pass the file:

```bash
npm run update:facilities -- saved-page.html
```

You can also edit the JSON by hand:

- `fsa.major` and `fsa.nonMajor` hold ranges (`"A1A-A1H"`), single FSAs (`"A1N"`), or two-character prefixes (`"T2"`).
- `scanNames` are the city names that count as that facility in scans. This is how "Dieppe" becomes the Moncton facility.
- `lat` and `lon` are approximate, at city level.

Run `npm test` after any edit.

The official table lets P0T–P0X and P7A–P9N use either Toronto or Winnipeg, so those FSAs stay listed under both and the shorter route wins.

## How the predicted route works

`server/data/network.json` is a simple undirected graph with approximate road distances. It includes the Port aux Basques ↔ North Sydney ferry, the Atlantic → Moncton → Montréal → Toronto spine, and the Toronto → Winnipeg → Prairies → Vancouver corridor.

1. **Start:** the last scan with a location. A scan in a facility city starts at that facility. Any other scan joins at one of its three nearest nodes on the same landmass, so a Newfoundland scan can't cross the water by road.
2. **Destination:** postal code → FSA → facility. For a city name, the facility in that city, or else the nearest one.
3. **Path:** Dijkstra's shortest path, then a straight line to the destination town.
4. **Stops remaining:** facilities ahead, plus one if the town is beyond its facility. Ferry terminals don't count.

This is an estimate. Real routing varies: the demo parcel, for example, was never scanned in St. John's. Lines between points are straight, not actual roads.

Scan locations that aren't facilities are geocoded with [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) at no more than one request per second, and results are cached in `server/.cache/geocode.json`.

## Project layout

```
server/tracker/apiClient.js    Canada Post sign-in, rate limiting and errors
server/tracker/canadaPost.js   Tracking API and parser
server/tracker/rating.js       Prices and transit times
server/tracker/postOffice.js   Post Office hours and locations
server/tracker/serviceInfo.js  Outage notices
server/tracker/enrich.js       Adds pickup hours and the on-time check
server/estimate.js             Cost and route estimates
server/tracker/publicPage.js   Headless-browser fallback when no key is set
server/trackingCache.js        Rate limiting and caching
server/buildView.js            Combines scans, places and the route for the frontend
server/route/                  FSA lookup and route prediction
server/data/                   Facilities, network, demo parcel, seeded geocodes
scripts/                       Facility table updater
src/                           React and Leaflet frontend
tests/                         Unit tests
```
