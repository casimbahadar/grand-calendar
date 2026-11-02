// Grand Calendar: event gatherer.
// Milestone 2: one source (Explore Waterloo Region iCal feed).
// Runs on GitHub Actions every 6 hours and writes events.json.
//
// Rule for every event: top-level fields are what the source stated.
// Anything the app worked out itself lives under `derived`, with a reason.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const OUT_FILE = 'events.json';
const TZ = 'America/Toronto';
const HORIZON_DAYS = 60;
const DELAY_MS = 2000; // pause between page requests, to be polite to the source
const DESC_MAX = 1000;
const UA = 'GrandCalendar/0.1 (personal events digest; https://github.com/casimbahadar/grand-calendar)';

export const SOURCES = [
  {
    id: 'explore-waterloo',
    name: 'Explore Waterloo Region',
    origin: 'https://explorewaterloo.ca',
    pageUrl: (n) => (n === 1
      ? 'https://explorewaterloo.ca/events/list/?ical=1'
      : `https://explorewaterloo.ca/events/list/page/${n}/?ical=1`),
    maxPages: 40,
  },
];

// ---------- Region by address ----------
// An event is "in" the region when a comma-separated part of its address is
// exactly one of these names. Edit these lists to add places.
const IN_REGION = [
  'kitchener', 'waterloo', 'cambridge', 'galt', 'preston', 'hespeler',
  'woolwich', 'elmira', 'st jacobs', 'breslau', 'conestogo', 'maryhill',
  'floradale', 'bloomingdale', 'west montrose', 'winterbourne', 'heidelberg',
  'wilmot', 'baden', 'new hamburg', 'petersburg', 'st agatha', 'new dundee',
  'mannheim', 'haysville',
  'wellesley', 'st clements', 'linwood', 'hawkesville', 'crosshill',
  'north dumfries', 'ayr', 'roseville', 'branchton',
];
const OUT_OF_REGION = [
  'guelph', 'stratford', 'brantford', 'paris', 'toronto', 'fergus', 'elora',
  'woodstock', 'london', 'hamilton', 'mississauga', 'milton', 'burlington',
  'drayton', 'listowel', 'st marys', 'tavistock', 'mitchell', 'arthur',
  'rockwood', 'puslinch', 'shakespeare',
];
const IN_SET = new Set(IN_REGION);
const OUT_SET = new Set(OUT_OF_REGION);

function normalizePlace(s) {
  return s.toLowerCase().replace(/\./g, '').replace(/\bsaint\b/g, 'st').replace(/\s+/g, ' ').trim();
}

export function regionOf(location) {
  if (!location) return { status: 'unknown', how: 'no address in source' };
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) if (IN_SET.has(normalizePlace(p))) return { status: 'in', place: p, how: 'place name in address' };
  for (const p of parts) if (OUT_SET.has(normalizePlace(p))) return { status: 'out', place: p, how: 'place name in address' };
  return { status: 'unknown', how: 'no known place name in address' };
}

// ---------- iCal parsing ----------
function unescapeText(s) {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function splitProp(line) {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

function parseHead(head) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (const c of head) {
    if (c === '"') { inQ = !inQ; cur += c; } else if (c === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params };
}

// Returns one object per VEVENT: { NAME: { value, params } }. Values are still escaped.
export function parseICS(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const unfolded = [];
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  const events = [];
  let cur = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const sp = splitProp(line);
    if (!sp) continue;
    const { name, params } = parseHead(sp[0]);
    if (name === 'CATEGORIES' && cur.CATEGORIES) cur.CATEGORIES.value += `,${sp[1]}`;
    else if (!cur[name]) cur[name] = { value: sp[1], params };
  }
  return events;
}

const fmtToronto = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function torontoParts(date) {
  return Object.fromEntries(fmtToronto.formatToParts(date).map((p) => [p.type, p.value]));
}

function parseDT(value, params = {}) {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, time: null, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  if (m[7] === 'Z') {
    const p = torontoParts(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, allDay: false, convertedFromUtc: true };
  }
  const out = { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, allDay: false };
  if (params.TZID && params.TZID !== TZ) out.tzid = params.TZID;
  return out;
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayToronto(now = new Date()) {
  const p = torontoParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

// Explore Waterloo leaves commas inside category names unescaped
// ("Arts, Culture, Heritage & Live Performance,Event"). Separators have no space after them.
function splitCategories(raw) {
  return raw.split(/(?<!\\),(?! )/).map((c) => unescapeText(c).trim()).filter(Boolean);
}

export function normalizeEvent(raw, source, checkedAt) {
  const val = (k) => (raw[k] ? raw[k].value : null);
  const uid = val('UID');
  const title = val('SUMMARY') ? unescapeText(val('SUMMARY')).trim() : null;
  const start = raw.DTSTART ? parseDT(raw.DTSTART.value, raw.DTSTART.params) : null;
  if (!uid || !title || !start) return null; // unusable without these three

  let end = raw.DTEND ? parseDT(raw.DTEND.value, raw.DTEND.params) : null;
  const notes = [];
  if (start.convertedFromUtc) notes.push('Start time converted from UTC to Toronto time.');
  if (start.tzid) notes.push(`Source time zone is ${start.tzid}; time shown as given.`);

  let timeListed = !start.allDay;
  if (end && end.allDay && start.allDay) {
    // iCal all-day end dates are exclusive; show the last day instead.
    const last = addDays(end.date, -1);
    end = last >= start.date ? { date: last, time: null, allDay: true } : null;
    notes.push('All-day end date converted to the last day of the event.');
  }
  if (end && !end.allDay && end.date === start.date && end.time === start.time) {
    end = null;
    notes.push('Source end time equals start time; treated as end time not listed.');
    if (start.time === '00:00') {
      timeListed = false;
      notes.push('Source shows 00:00; treated as time not listed.');
    }
  }

  let description = val('DESCRIPTION') ? unescapeText(val('DESCRIPTION')).trim() : '';
  let descriptionTruncated = false;
  if (description.length > DESC_MAX) { description = description.slice(0, DESC_MAX); descriptionTruncated = true; }

  const rawUrl = val('URL') ? unescapeText(val('URL')).trim() : null;
  const url = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : null;
  const location = val('LOCATION') ? unescapeText(val('LOCATION')).replace(/\s+/g, ' ').trim() : null;
  const categories = val('CATEGORIES') ? splitCategories(val('CATEGORIES')) : [];

  // ORGANIZER is deliberately not kept: it can hold a private person's name and email.
  return {
    id: `${source.id}:${uid}`,
    source: source.id,
    title,
    description,
    descriptionTruncated,
    url,
    location,
    categories,
    start: { date: start.date, time: start.time },
    end: end ? { date: end.date, time: end.time } : null,
    allDay: start.allDay,
    lastChecked: checkedAt,
    derived: { region: regionOf(location), timeListed, notes },
  };
}

// ---------- robots.txt ----------
function ruleToRegex(rule) {
  const esc = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc.endsWith('\\$') ? `${esc.slice(0, -2)}$` : esc}`);
}

// True when robots.txt rules for all user agents (*) block this path.
export function disallowed(robotsTxt, path) {
  let applies = false;
  let inAgentLines = false;
  const disallows = [];
  const allows = [];
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!inAgentLines) applies = false;
      inAgentLines = true;
      if (v === '*') applies = true;
    } else {
      inAgentLines = false;
      if (applies && key === 'disallow' && v) disallows.push(v);
      if (applies && key === 'allow' && v) allows.push(v);
    }
  }
  const longest = (rules) => rules.filter((r) => ruleToRegex(r).test(path)).reduce((m, r) => Math.max(m, r.length), -1);
  const d = longest(disallows);
  return d >= 0 && d > longest(allows);
}

async function robotsCheck(source) {
  const paths = [1, 2].map((n) => { const u = new URL(source.pageUrl(n)); return u.pathname + u.search; });
  try {
    const res = await fetch(`${source.origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    // No robots.txt (4xx) means no rules. A server error means we can't tell, so skip this run.
    if (res.status >= 500) return { allowed: false, note: `robots.txt returned HTTP ${res.status}; skipped this run` };
    if (!res.ok) return { allowed: true, note: `robots.txt returned HTTP ${res.status} (no rules)` };
    const txt = await res.text();
    return { allowed: !paths.some((p) => disallowed(txt, p)) };
  } catch {
    return { allowed: false, note: 'robots.txt could not be reached; skipped this run' };
  }
}

// ---------- Fetching ----------
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function gatherPaged(source, checkedAt) {
  const horizon = addDays(todayToronto(), HORIZON_DAYS);
  const byId = new Map();
  let pages = 0;
  let truncated = false;
  let partialError = null;
  for (let n = 1; n <= source.maxPages; n++) {
    if (n > 1) await sleep(DELAY_MS);
    let text;
    try {
      const res = await fetch(source.pageUrl(n), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`HTTP ${res.status} on page ${n}`);
      text = await res.text();
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error(`page ${n} was not a calendar file`);
    } catch (err) {
      if (n === 1) throw err;
      partialError = String(err.message || err);
      truncated = true;
      break;
    }
    pages = n;
    const evs = parseICS(text).map((r) => normalizeEvent(r, source, checkedAt)).filter(Boolean);
    if (evs.length === 0) break;
    let added = 0;
    for (const e of evs) if (e.start.date <= horizon && !byId.has(e.id)) { byId.set(e.id, e); added++; }
    if (evs.every((e) => e.start.date > horizon)) break;
    if (added === 0) break; // page repeated what we already had
    if (n === source.maxPages) truncated = true;
  }
  return { events: [...byId.values()], pages, truncated, partialError };
}

async function readPrevious() {
  try { return JSON.parse(await readFile(OUT_FILE, 'utf8')); } catch { return null; }
}

export async function run({ fixturePath = null } = {}) {
  const checkedAt = new Date().toISOString();
  const today = todayToronto();
  const prev = await readPrevious();
  const sourcesOut = [];
  let events = [];

  for (const source of SOURCES) {
    const status = { id: source.id, name: source.name, checkedAt };
    const prevStatus = prev?.sources?.find((s) => s.id === source.id);
    try {
      let result;
      if (fixturePath) {
        const text = await readFile(fixturePath, 'utf8');
        result = { events: parseICS(text).map((r) => normalizeEvent(r, source, checkedAt)).filter(Boolean), pages: 1, truncated: false, fixture: true };
      } else {
        const robots = await robotsCheck(source);
        if (robots.note) status.note = robots.note;
        if (!robots.allowed) throw new Error(robots.note || 'robots.txt disallows the feed; source skipped');
        result = await gatherPaged(source, checkedAt);
      }
      events.push(...result.events);
      Object.assign(status, {
        ok: true, lastGoodAt: checkedAt, count: result.events.length, pages: result.pages, truncated: result.truncated,
        ...(result.partialError ? { partialError: result.partialError } : {}),
        ...(result.fixture ? { fixture: true } : {}),
      });
    } catch (err) {
      // Keep the last good copy rather than wiping the source; the app shows its age.
      const old = (prev?.events || []).filter((e) => e.source === source.id);
      events.push(...old);
      Object.assign(status, { ok: false, error: String(err.message || err), count: old.length, lastGoodAt: prevStatus?.lastGoodAt ?? null });
    }
    sourcesOut.push(status);
  }

  if (!fixturePath) events = events.filter((e) => (e.end ? e.end.date : e.start.date) >= today);
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  unique.sort((a, b) => `${a.start.date}T${a.start.time || '00:00'}`.localeCompare(`${b.start.date}T${b.start.time || '00:00'}`));

  const out = { generatedAt: checkedAt, timeZone: TZ, sources: sourcesOut, events: unique };
  await writeFile(OUT_FILE, JSON.stringify(out));
  const allFailed = sourcesOut.every((s) => !s.ok);
  return { out, allFailed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--fixture');
  run({ fixturePath: i >= 0 ? process.argv[i + 1] : null }).then(({ out, allFailed }) => {
    for (const s of out.sources) console.log(`${s.name}: ${s.ok ? 'ok' : `FAILED (${s.error})`}, ${s.count} events${s.truncated ? ', truncated' : ''}`);
    console.log(`Total events written: ${out.events.length}`);
    if (allFailed) process.exitCode = 1;
  });
}
