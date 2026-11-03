// Grand Calendar: shared rules used by the GitHub job (gather.mjs) and the phone app.
// No Node-only features here, so the same file runs in the browser.

// ---------- Text ----------
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ocirc: 'ô', uuml: 'ü', ouml: 'ö', auml: 'ä',
  middot: '·', bull: '•', deg: '°', copy: '©', reg: '®', trade: '™', times: '×', frac12: '½',
};

export function decodeEntities(t) {
  return t
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+\d*);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

// HTML description to plain text, keeping paragraph breaks.
export function htmlToText(h) {
  if (!h) return '';
  const withBreaks = h.replace(/<(script|style)[\s\S]*?<\/(script|style)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Region by address ----------
// An event is "in" the region when a comma-separated part of its address is exactly
// one of these names. Edit these lists to add places.
export const IN_REGION = [
  'kitchener', 'waterloo', 'cambridge', 'galt', 'preston', 'hespeler',
  'woolwich', 'elmira', 'st jacobs', 'breslau', 'conestogo', 'maryhill',
  'floradale', 'bloomingdale', 'west montrose', 'winterbourne', 'heidelberg',
  'wilmot', 'baden', 'new hamburg', 'petersburg', 'st agatha', 'new dundee',
  'mannheim', 'haysville',
  'wellesley', 'st clements', 'linwood', 'hawkesville', 'crosshill',
  'north dumfries', 'ayr', 'roseville', 'branchton',
  // Added Nov 2026 at the user's request: Stratford (Perth County), outside Waterloo Region.
  'stratford',
];
export const OUT_OF_REGION = [
  'guelph', 'brantford', 'paris', 'toronto', 'fergus', 'elora',
  'woodstock', 'london', 'hamilton', 'mississauga', 'milton', 'burlington',
  'drayton', 'listowel', 'st marys', 'tavistock', 'mitchell', 'arthur',
  'rockwood', 'puslinch', 'shakespeare',
];
const IN_SET = new Set(IN_REGION);
const OUT_SET = new Set(OUT_OF_REGION);

function normalizePlace(s) {
  return s.toLowerCase().replace(/\./g, '').replace(/\bsaint\b/g, 'st')
    .replace(/^(township|city|town) of /, '')
    .replace(/\s+(on|ontario)$/, '') // "Waterloo ON" written without a comma
    .replace(/\s+/g, ' ').trim();
}

function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

export function regionOf(location) {
  if (!location) return { status: 'unknown', how: 'no address in source' };
  const parts = location.split(',').map((p) => normalizePlace(p)).filter(Boolean);
  for (const p of parts) if (IN_SET.has(p)) return { status: 'in', place: titleCase(p), how: 'place name in address' };
  for (const p of parts) if (OUT_SET.has(p)) return { status: 'out', place: titleCase(p), how: 'place name in address' };
  // Fallback for addresses like "145 Bedford Rd. Kitchener" or "Downtown Hespeler":
  // an in-region name at the end of a part. Out-of-region names still need an exact match.
  for (const p of parts) {
    for (const name of IN_REGION) {
      if (p.endsWith(` ${name}`)) return { status: 'in', place: titleCase(name), how: 'place name at end of an address part' };
    }
  }
  return { status: 'unknown', how: 'no known place name in address' };
}

// ---------- Time rules ----------
// Sources use placeholder times. These rules stop the app from showing them as real times.
// start/end: { date: 'YYYY-MM-DD', time: 'HH:MM' | null, allDay }. Adds reasons to notes.
export function applyTimeRules(start, end, notes) {
  let timeListed = !start.allDay;
  let e = end;
  if (e && !e.allDay && start.time === '00:00' && e.date === start.date && e.time === '23:59') {
    e = null;
    timeListed = false;
    notes.push('Source gives 00:00 to 23:59 (its way of marking all day); treated as hours not listed.');
  }
  if (e && !e.allDay && e.date === start.date && e.time === start.time) {
    e = null;
    notes.push('Source end time equals start time; treated as end time not listed.');
    if (start.time === '00:00') {
      timeListed = false;
      notes.push('Source shows 00:00; treated as time not listed.');
    }
  }
  return { end: e, timeListed };
}
