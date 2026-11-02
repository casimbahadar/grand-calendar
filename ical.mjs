// Grand Calendar: iCal (.ics) reading, shared by the GitHub job and the phone app.
// No Node-only features, so it runs in the browser too.
//
// Rule for every event: top-level fields are what the source stated.
// Anything the app worked out itself lives under `derived`, with a reason.

import { readAges } from './ages.mjs';
import { regionOf, applyTimeRules } from './core.mjs';

const TZ = 'America/Toronto';
const DESC_MAX = 1000;

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

export function addDays(isoDate, n) {
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

  if (end && end.allDay && start.allDay) {
    // iCal all-day end dates are exclusive; show the last day instead.
    const last = addDays(end.date, -1);
    end = last >= start.date ? { date: last, time: null, allDay: true } : null;
    notes.push('All-day end date converted to the last day of the event.');
  }
  const timed = applyTimeRules(start, end, notes);
  end = timed.end;
  const { timeListed } = timed;

  let description = val('DESCRIPTION') ? unescapeText(val('DESCRIPTION')).trim() : '';
  const age = readAges(title, description); // read before the description is shortened
  let descriptionTruncated = false;
  if (description.length > DESC_MAX) { description = description.slice(0, DESC_MAX); descriptionTruncated = true; }

  const rawUrl = val('URL') ? unescapeText(val('URL')).trim() : null;
  let url = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : null;
  if (!url && source.eventUrl) {
    url = source.eventUrl(uid);
    notes.push('Event link built from the source\'s event number (its feed has no link field).');
  }
  const location = val('LOCATION') ? unescapeText(val('LOCATION')).replace(/\s+/g, ' ').trim() : null;
  const categories = val('CATEGORIES') ? splitCategories(val('CATEGORIES')) : [];
  const status = val('STATUS') ? val('STATUS').trim().toUpperCase() : null; // e.g. CONFIRMED, CANCELLED
  let geo = null;
  const g = val('GEO') ? /^(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?)$/.exec(val('GEO').trim()) : null;
  if (g) geo = { lat: +g[1], lng: +g[2] };

  let region = regionOf(location);
  if (region.status === 'unknown' && source.defaultPlace) {
    region = { status: 'in', place: source.defaultPlace, how: `${source.name} venue; its venue names don't include a town` };
  }

  // Explore Waterloo's LOCATION is "Venue, street, Town, ON, postcode, Canada".
  // venueKey matches venues.json, which uses the same venue name and street.
  const locParts = location ? location.split(',').map((x) => x.trim()) : [];
  const venueInfo = source.venueKeyFromLocation && locParts.length >= 2
    ? { venue: locParts[0], venueKey: `${locParts[0]}|${locParts[1]}`.toLowerCase() }
    : {};

  // ORGANIZER is deliberately not kept: it can hold a private person's name and email.
  return {
    ...venueInfo,
    id: `${source.id}:${uid}`,
    source: source.id,
    title,
    description,
    descriptionTruncated,
    url,
    location,
    categories,
    status,
    geo,
    start: { date: start.date, time: start.time },
    end: end ? { date: end.date, time: end.time } : null,
    allDay: start.allDay,
    lastChecked: checkedAt,
    derived: { region, timeListed, age, notes },
  };
}

