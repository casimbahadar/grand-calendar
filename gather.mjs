// Grand Calendar: event gatherer.
// Runs on GitHub Actions every 6 hours and writes events.json.
// Sources marked server: false are skipped here (Explore Waterloo blocks GitHub's
// servers); the app reads those directly on the phone instead.
//
// Rule for every event: top-level fields are what the source stated.
// Anything the app worked out itself lives under `derived`, with a reason.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { regionOf, decodeEntities } from './core.mjs';
import { parseICS, normalizeEvent, addDays, todayToronto } from './ical.mjs';

export { parseICS, normalizeEvent, todayToronto };

export { regionOf }; // kept for the tests

const OUT_FILE = 'events.json';
const TZ = 'America/Toronto';
const HORIZON_DAYS = 60;
const DELAY_MS = 2000; // pause between page requests, to be polite to the source
const STATUS_DAYS = 14; // registration status is checked on event pages for events this close
const STATUS_EVERY_MS = 5.5 * 60 * 60 * 1000; // full status pass about every 6 hours (runs can start late)
const UA = 'GrandCalendar/0.1 (personal events digest; https://github.com/casimbahadar/grand-calendar)';

const wplFeed = () => {
  // Built the same way calendar.wpl.ca builds its own iCal link (up to 500 upcoming events).
  const filters = { feedType: 'ical', filters: { location: ['all'], ages: ['all'], types: ['all'], tags: [], term: '', days: 1 } };
  return `https://calendar.wpl.ca/feeds?data=${Buffer.from(JSON.stringify(filters)).toString('base64')}`;
};

export const SOURCES = [
  {
    id: 'explore-waterloo',
    name: 'Explore Waterloo Region',
    kind: 'ical-paged',
    server: false, // HTTP 403 from GitHub's servers (Nov 2, 2026); read on the phone instead
    origin: 'https://explorewaterloo.ca',
    pageUrl: (n) => (n === 1
      ? 'https://explorewaterloo.ca/events/list/?ical=1'
      : `https://explorewaterloo.ca/events/list/page/${n}/?ical=1`),
    maxPages: 40,
  },
  {
    id: 'wpl',
    name: 'Waterloo Public Library',
    kind: 'ical-single',
    server: true,
    origin: 'https://calendar.wpl.ca',
    feedUrl: wplFeed,
    eventUrl: (uid) => `https://calendar.wpl.ca/event/${encodeURIComponent(uid)}`,
    // Library venues are branch names with no town, e.g. "Eastside Branch - Program Room".
    defaultPlace: 'Waterloo',
    statusFromPages: true,
  },
  // Business and tech sources (Nov 2026). All four publish calendar feeds meant for subscribing,
  // and their robots.txt files don't block them. Luma's feeds give times in UTC (converted) and
  // put each event's link in its description.
  {
    id: 'communitech',
    name: 'Communitech',
    kind: 'ical-single',
    server: true,
    business: true,
    origin: 'https://api.luma.com',
    feedUrl: () => 'https://api.luma.com/ics/get?entity=calendar&id=cal-xN0J6QkQRTN3jiU',
    linkFromDescription: /https:\/\/luma\.com\/[A-Za-z0-9-]+/,
  },
  {
    id: 'waterloo-tech',
    name: 'Waterloo tech community calendar',
    kind: 'ical-single',
    server: true,
    business: true,
    origin: 'https://api.luma.com',
    feedUrl: () => 'https://api.luma.com/ics/get?entity=calendar&id=cal-rJoHBmPlHGvg5F8',
    linkFromDescription: /https:\/\/luma\.com\/[A-Za-z0-9-]+/,
    // The shared calendar (kept by Builders Club) also lists Communitech's events; keep one copy.
    skipSameEventAs: ['communitech'],
  },
  {
    id: 'small-business-centre',
    name: 'Waterloo Region Small Business Centre',
    kind: 'ical-single',
    server: true,
    business: true,
    origin: 'https://www.waterlooregionsmallbusiness.com',
    feedUrl: () => 'https://www.waterlooregionsmallbusiness.com/events/?ical=1',
  },
  {
    id: 'accelerator-centre',
    name: 'Accelerator Centre',
    kind: 'ical-single',
    server: true,
    business: true,
    origin: 'https://www.acceleratorcentre.com',
    feedUrl: () => 'https://www.acceleratorcentre.com/events-listings/?ical=1',
    // Its feed normally has each event's link; if one is missing, link to its events calendar.
    fallbackUrl: 'https://www.acceleratorcentre.com/event-calendar/',
  },
];

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
  const urls = source.kind === 'ical-paged' ? [source.pageUrl(1), source.pageUrl(2)] : [source.feedUrl()];
  const paths = urls.map((x) => { const u = new URL(x); return u.pathname + u.search; });
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

async function gatherSingle(source, checkedAt) {
  const horizon = addDays(todayToronto(), HORIZON_DAYS);
  const res = await fetch(source.feedUrl(), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('response was not a calendar file');
  const all = parseICS(text).map((r) => normalizeEvent(r, source, checkedAt)).filter(Boolean);
  // Upcoming only (some feeds keep years of past events), so counts match what the app shows.
  const today = todayToronto();
  const events = all.filter((e) => e.start.date <= horizon && (e.end ? e.end.date : e.start.date) >= today);
  // The feed caps at 500 events; if it is full we may be missing some.
  return { events, pages: 1, truncated: all.length >= 500 };
}

// ---------- Registration status from library event pages ----------
// Each page also lists *other* events in a sidebar, with their own "full" notices.
// Only the part before the first sidebar entry belongs to this event.
export function parseWplStatus(html, eventId) {
  const cut = html.indexOf('<div class="amev-event-description"');
  const main = cut >= 0 ? html.slice(0, cut) : html;
  const text = decodeEntities(main.replace(/<(script|style)[\s\S]*?<\/(script|style)>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const idAttr = `data-eventid="${eventId}"`;
  const waitlist = [...main.matchAll(/<[^>]*registerForEvent[^>]*>/g)]
    .some((m) => m[0].includes(idAttr) && m[0].includes('data-regtype="2"'));
  const seats = /(\d+) Seats? Remaining/i.exec(text);
  const opens = /Registration (?:opens|will open|begins)[^.<]{0,60}/i.exec(text);
  const dropIn = /\|\s*Drop-in\s*\|/i.test(text);
  let state;
  if (/This event is full/i.test(text)) state = 'full';
  else if (/Registration (?:is )?now closed/i.test(text)) state = 'closed';
  else if (seats) state = 'open';
  else if (opens) state = 'not-open-yet';
  else if (dropIn) state = 'drop-in';
  else state = 'not-stated';
  return {
    state,
    seatsRemaining: seats ? +seats[1] : null,
    waitlist,
    dropIn,
    opensText: opens ? opens[0].trim() : null,
  };
}

// Which events get their page loaded this run. On a full pass: every event in the window.
// Between full passes: only events with no known status yet (newly posted, or just
// moved into the 14-day window). Everything else keeps its last status and check time.
export function needsStatusCheck(e, prevE, fullPass, until) {
  if (e.start.date > until) return false;
  if (fullPass) return true;
  return !prevE || !prevE.registration;
}

async function addPageStatus(source, events, prev, fullPass) {
  const until = addDays(todayToronto(), STATUS_DAYS);
  const prevById = new Map((prev?.events || []).map((e) => [e.id, e]));
  let checked = 0;
  let failed = 0;
  for (const e of events) {
    const prevE = prevById.get(e.id);
    if (!needsStatusCheck(e, prevE, fullPass, until)) {
      e.registration = e.start.date > until ? null : (prevE?.registration ?? null);
      continue;
    }
    if (checked + failed > 0) await sleep(DELAY_MS);
    try {
      const res = await fetch(e.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const uid = e.id.slice(source.id.length + 1);
      e.registration = { ...parseWplStatus(await res.text(), uid), checkedAt: new Date().toISOString(), from: 'event page' };
      checked++;
      if (checked % 10 === 0) console.log(`  ${source.name}: checked ${checked} event pages so far`);
    } catch {
      // Keep the last known status, with its old check time, rather than showing nothing.
      e.registration = prevE?.registration ?? null;
      failed++;
    }
  }
  return { checked, failed };
}

// firstSeen = when Grand Calendar first saw the event. The app uses it for the "New" badge.
// Events already in the previous file keep their time (or that file's time, for files made
// before this field existed), so an upgrade doesn't mark everything as new.
// The same Luma event can sit on two Luma calendars; keep the first copy (Luma's event ID is shared).
export function dropSameLumaEvents(already, incoming, fromSources) {
  const lumaId = (e) => (e.id.match(/evt-[A-Za-z0-9]+/) || [null])[0];
  const seen = new Set(already.filter((e) => fromSources.includes(e.source)).map(lumaId).filter(Boolean));
  return incoming.filter((e) => !seen.has(lumaId(e)));
}

export function assignFirstSeen(events, prev, now) {
  const prevById = new Map((prev?.events || []).map((e) => [e.id, e]));
  for (const e of events) {
    const p = prevById.get(e.id);
    e.firstSeen = p ? (p.firstSeen ?? prev.generatedAt) : now;
  }
}

async function readPrevious() {
  try { return JSON.parse(await readFile(OUT_FILE, 'utf8')); } catch { return null; }
}

export async function run({ fixtures = {} } = {}) {
  const fixtureMode = Object.keys(fixtures).length > 0;
  const checkedAt = new Date().toISOString();
  const today = todayToronto();
  const prev = await readPrevious();
  const sourcesOut = [];
  let events = [];

  for (const source of SOURCES) {
    if (!fixtureMode && !source.server) continue;
    if (fixtureMode && !fixtures[source.id]) continue;
    const status = { id: source.id, name: source.name, checkedAt };
    const prevStatus = prev?.sources?.find((s) => s.id === source.id);
    try {
      let result;
      if (fixtureMode) {
        const text = await readFile(fixtures[source.id], 'utf8');
        result = { events: parseICS(text).map((r) => normalizeEvent(r, source, checkedAt)).filter(Boolean), pages: 1, truncated: false, fixture: true };
      } else {
        const robots = await robotsCheck(source);
        if (robots.note) status.note = robots.note;
        if (!robots.allowed) throw new Error(robots.note || 'robots.txt disallows the feed; source skipped');
        result = source.kind === 'ical-paged' ? await gatherPaged(source, checkedAt) : await gatherSingle(source, checkedAt);
        if (source.statusFromPages) {
          const lastFull = Date.parse(prevStatus?.statusPages?.fullPassAt || '') || 0;
          const fullPass = Date.now() - lastFull >= STATUS_EVERY_MS;
          const st = await addPageStatus(source, result.events, prev, fullPass);
          status.statusPages = {
            mode: fullPass ? 'full pass' : 'new events only',
            checked: st.checked, failed: st.failed, withinDays: STATUS_DAYS,
            fullPassAt: fullPass ? checkedAt : prevStatus.statusPages.fullPassAt,
          };
        }
      }
      if (source.skipSameEventAs) {
        const before = result.events.length;
        result.events = dropSameLumaEvents(events, result.events, source.skipSameEventAs);
        result.duplicatesSkipped = before - result.events.length;
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

  assignFirstSeen(events, prev, checkedAt);
  if (!fixtureMode) events = events.filter((e) => (e.end ? e.end.date : e.start.date) >= today);
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  unique.sort((a, b) => `${a.start.date}T${a.start.time || '00:00'}`.localeCompare(`${b.start.date}T${b.start.time || '00:00'}`));

  const out = { generatedAt: checkedAt, timeZone: TZ, sources: sourcesOut, events: unique };
  await writeFile(OUT_FILE, JSON.stringify(out));
  const allFailed = sourcesOut.every((s) => !s.ok);
  return { out, allFailed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Offline test: node gather.mjs --fixture explore-waterloo=explore-sample.ics --fixture wpl=wpl-sample.ics
  const fixtures = {};
  process.argv.forEach((a, i) => {
    if (a === '--fixture') { const [id, path] = process.argv[i + 1].split('='); fixtures[id] = path; }
  });
  run({ fixtures }).then(({ out, allFailed }) => {
    for (const s of out.sources) console.log(`${s.name}: ${s.ok ? 'ok' : `FAILED (${s.error})`}, ${s.count} events${s.truncated ? ', may be incomplete' : ''}`);
    console.log(`Total events written: ${out.events.length}`);
    if (allFailed) process.exitCode = 1;
  });
}
