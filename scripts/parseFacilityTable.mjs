// Turns the HTML of Canada Post's official facility page into FSA ranges.
const FSA_TOKEN = /\b([A-Z]\d[A-Z]?)(?:\s+to\s+([A-Z]\d[A-Z]?))?(?![A-Z0-9])/g;

const stripTags = (html) =>
  html
    .replace(/<sup[^>]*>.*?<\/sup>/gis, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function parseRanges(cellText) {
  if (/not applicable/i.test(cellText)) return [];
  const ranges = [];
  for (const [, start, end] of cellText.matchAll(FSA_TOKEN)) {
    ranges.push(end ? `${start}-${end}` : start);
  }
  return ranges;
}

export function parseFacilityTable(html) {
  const rows = [...html.matchAll(/<tr\b.*?<\/tr>/gis)].map(([row]) =>
    [...row.matchAll(/<t[dh]\b[^>]*>(.*?)<\/t[dh]>/gis)].map(([, cell]) => stripTags(cell)),
  );
  return rows
    .filter((cells) => cells.length === 3 && !/^processing facility/i.test(cells[0]))
    .map(([name, major, nonMajor]) => ({
      name,
      major: parseRanges(major),
      nonMajor: parseRanges(nonMajor),
    }));
}
