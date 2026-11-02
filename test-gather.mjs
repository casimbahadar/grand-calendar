// Run with: node test-gather.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseICS, normalizeEvent, regionOf, disallowed, SOURCES, parseWplStatus, needsStatusCheck, assignFirstSeen } from './gather.mjs';

const text = await readFile(new URL('./explore-sample.ics', import.meta.url), 'utf8');
const source = SOURCES.find((x) => x.id === 'explore-waterloo');
const raws = parseICS(text);
const events = raws.map((r) => normalizeEvent(r, source, '2026-11-02T00:00:00.000Z')).filter(Boolean);
const byTitle = (t) => events.find((e) => e.title.startsWith(t));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

check('parses 11 VEVENTs, drops the one without a start', () => {
  assert.equal(raws.length, 11);
  assert.equal(events.length, 10);
  assert.equal(byTitle('SYNTHETIC TEST missing start'), undefined);
});
check('unfolds folded lines', () => assert.equal(byTitle('SYNTHETIC TEST all-day').title, 'SYNTHETIC TEST all-day event with a folded title line'));
check('unescapes commas', () => assert.match(byTitle('Christmas at the Castle').description, /enchanting, lavish/));
check('keeps commas inside category names', () => assert.deepEqual(byTitle('Dog Mic').categories, ['Arts, Culture, Heritage & Live Performance', 'Event']));
check('splits normal category lists', () => assert.deepEqual(byTitle('4th Annual').categories, ['Event', 'Family Friendly', 'Food & Drink', 'Free Events', 'Holiday Events', 'Ongoing Events', 'Shopping']));
check('keeps unicode text intact', () => assert.match(byTitle('Raptors').description, /𝘕𝘰 𝘵𝘪𝘤𝘬𝘦𝘵𝘴/));

check('region: Waterloo, Baden, Kitchener, St. Jacobs, Elmira, "Cambridge " are in', () => {
  for (const [t, place] of [['Dog Mic', 'Waterloo'], ['Christmas at the Castle', 'Baden'], ['Euchre', 'Kitchener'],
    ['Holiday Sip', 'St. Jacobs'], ['4th Annual', 'Elmira'], ['Dance Legion', 'Cambridge'], ['SYNTHETIC TEST all-day', 'St Clements']]) {
    const r = byTitle(t).derived.region;
    assert.equal(r.status, 'in', t);
    assert.equal(r.place.toLowerCase(), place.toLowerCase().replace(/\./g, ''), t);
  }
});
check('region: Stratford is out, no address is unknown', () => {
  assert.equal(byTitle('SYNTHETIC TEST Stratford').derived.region.status, 'out');
  assert.equal(byTitle('SYNTHETIC TEST UTC').derived.region.status, 'unknown');
  assert.equal(regionOf('Some Hall, 1 Main St, Nowhereville, ON').status, 'unknown');
});

check('region: address formats seen in the live feed', () => {
  const cases = [
    ['Vector Space, 187 King St South, Unit106, Waterloo ON, N2L 0A5, ON, Canada', 'in'],
    ['Kwartzlab, 145 Bedford Rd. Kitchener, ON, ON, Canada', 'in'],
    ['Base Church – Bloomingdale, 850 Sawmill Rd , Township of Woolwich, ON, Canada', 'in'],
    ['Downtown Hespeler, Groh Ave → Guelph Ave & Sheffield St, ON, Canada', 'in'],
    ['Vector Space, info@kwvector.space, ON, Canada', 'unknown'],
    ['ON', 'unknown'],
    ['A Hall, 9 Main St, Guelph, ON, Canada', 'out'],
  ];
  for (const [loc, want] of cases) assert.equal(regionOf(loc).status, want, loc);
});

check('00:00 with equal end is "time not listed"', () => {
  for (const t of ['Christmas at the Castle', 'Dance Legion']) {
    const e = byTitle(t);
    assert.equal(e.derived.timeListed, false, t);
    assert.equal(e.end, null, t);
  }
});
check('00:00 to 23:59 is "hours not listed" (Christkindl Market pattern)', () => {
  const raw = parseICS('BEGIN:VEVENT\nUID:x\nSUMMARY:T\nDTSTART;TZID=America/Toronto:20261203T000000\nDTEND;TZID=America/Toronto:20261203T235900\nEND:VEVENT')[0];
  const e = normalizeEvent(raw, source, 'x');
  assert.equal(e.derived.timeListed, false);
  assert.equal(e.end, null);
});
check('equal start and end at 19:30 keeps the start, drops the end', () => {
  const e = byTitle('Raptors');
  assert.equal(e.start.time, '19:30');
  assert.equal(e.end, null);
  assert.equal(e.derived.timeListed, true);
});
check('normal times pass through', () => {
  const e = byTitle('Euchre');
  assert.deepEqual(e.start, { date: '2026-11-25', time: '19:00' });
  assert.deepEqual(e.end, { date: '2026-11-25', time: '21:30' });
});
check('all-day end date made inclusive', () => {
  const e = byTitle('SYNTHETIC TEST all-day');
  assert.equal(e.allDay, true);
  assert.deepEqual(e.start, { date: '2026-12-05', time: null });
  assert.deepEqual(e.end, { date: '2026-12-05', time: null });
});
check('UTC 15:00 on Dec 6 becomes 10:00 Toronto (EST)', () => {
  const e = byTitle('SYNTHETIC TEST UTC');
  assert.deepEqual(e.start, { date: '2026-12-06', time: '10:00' });
  assert.ok(e.derived.notes.some((n) => n.includes('UTC')));
});
check('non-http links are dropped', () => assert.equal(byTitle('SYNTHETIC TEST Stratford').url, null));
check('organizer name and email are not kept', () => {
  const json = JSON.stringify(events);
  assert.ok(!json.includes('Metzger'));
  assert.ok(!json.toLowerCase().includes('joyfulvendors'));
});

check('robots.txt rules', () => {
  assert.equal(disallowed('User-agent: *\nDisallow: /events/', '/events/list/?ical=1'), true);
  assert.equal(disallowed('User-agent: Googlebot\nDisallow: /', '/events/list/?ical=1'), false);
  assert.equal(disallowed('User-agent: *\nDisallow: /*?ical=', '/events/list/?ical=1'), true);
  assert.equal(disallowed('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php', '/events/list/?ical=1'), false);
  assert.equal(disallowed('User-agent: *\nDisallow: /events/\nAllow: /events/list/', '/events/list/?ical=1'), false);
});

// ---------- Waterloo Public Library (6 real events copied from the live feed) ----------
const wplSource = SOURCES.find((x) => x.id === 'wpl');
const wplText = await readFile(new URL('./wpl-sample.ics', import.meta.url), 'utf8');
const wpl = parseICS(wplText).map((r) => normalizeEvent(r, wplSource, 'x')).filter(Boolean);
const w = (t) => wpl.find((e) => e.title.startsWith(t));

check('WPL: 6 events, titles trimmed', () => {
  assert.equal(wpl.length, 6);
  assert.equal(w('20s & 30s').title, '20s & 30s Social Club');
});
check('WPL: UTC times match what calendar.wpl.ca shows', () => {
  // Explore Play Learn: page shows Mon Nov 2, 10:30am - 11:15am
  assert.deepEqual(w('Explore Play Learn').start, { date: '2026-11-02', time: '10:30' });
  assert.deepEqual(w('Explore Play Learn').end, { date: '2026-11-02', time: '11:15' });
  // 20s & 30s Social Club: ends 01:00 UTC the next day, page shows Tue Nov 3, 6:00pm - 8:00pm
  assert.deepEqual(w('20s & 30s').start, { date: '2026-11-03', time: '18:00' });
  assert.deepEqual(w('20s & 30s').end, { date: '2026-11-03', time: '20:00' });
  // Picturebook Book Club: page shows Tue Nov 10, 11:30am - 12:15pm
  assert.deepEqual(w('Picturebook').start, { date: '2026-11-10', time: '11:30' });
});
check('WPL: region from the library default, labelled as such', () => {
  const r = w('Art and STEM').derived.region;
  assert.equal(r.status, 'in');
  assert.equal(r.place, 'Waterloo');
  assert.match(r.how, /Waterloo Public Library venue/);
});
check('WPL: link built from event number, coordinates and status kept', () => {
  const e = w('Explore Play Learn');
  assert.equal(e.url, 'https://calendar.wpl.ca/event/17242221');
  assert.ok(e.derived.notes.some((n) => n.includes('link built')));
  assert.deepEqual(e.geo, { lat: 43.474333, lng: -80.5710992 });
  assert.equal(e.status, 'CONFIRMED');
});
check('WPL: age line kept in the description, organizer dropped', () => {
  assert.equal(w('Picturebook').description, 'For kids ages 4 to 6 years old with a caregiver.');
  assert.ok(!JSON.stringify(wpl).includes('noreply@wpl.ca'));
});
check('Explore Waterloo is off for the GitHub job, the library is on', () => {
  assert.equal(SOURCES.find((x) => x.id === 'explore-waterloo').server, false);
  assert.equal(wplSource.server, true);
});

// ---------- Registration status (trimmed copies of 4 real calendar.wpl.ca pages) ----------
const page = async (id) => parseWplStatus(await readFile(new URL(`./wpl-page-${id}.html`, import.meta.url), 'utf8'), id);
const full = await page('17114664');
const open = await page('17114674');
const dropIn = await page('17242221');
const closed = await page('17321367');
check('status: full with a wait list (Mahjong Club, Nov 5)', () => {
  assert.equal(full.state, 'full');
  assert.equal(full.waitlist, true);
});
check('status: open with seats, ignoring "full" notices for other events in the sidebar', () => {
  assert.equal(open.state, 'open');
  assert.equal(open.seatsRemaining, 14);
  assert.equal(open.waitlist, false);
});
check('status: drop-in program (Explore Play Learn)', () => {
  assert.equal(dropIn.state, 'drop-in');
  assert.equal(dropIn.dropIn, true);
});
check('status: registration closed', () => assert.equal(closed.state, 'closed'));

// ---------- Hourly runs: what gets rechecked, and the "New" badge ----------
check('between full passes, only events without a known status get their page loaded', () => {
  const until = '2026-11-16';
  const known = { registration: { state: 'open' } };
  const ev = (date) => ({ start: { date } });
  assert.equal(needsStatusCheck(ev('2026-11-05'), undefined, false, until), true, 'newly posted');
  assert.equal(needsStatusCheck(ev('2026-11-05'), { registration: null }, false, until), true, 'just entered the window');
  assert.equal(needsStatusCheck(ev('2026-11-05'), known, false, until), false, 'already known');
  assert.equal(needsStatusCheck(ev('2026-11-05'), known, true, until), true, 'full pass rechecks it');
  assert.equal(needsStatusCheck(ev('2026-12-20'), undefined, true, until), false, 'beyond 14 days');
});
check('firstSeen: new events get now, existing keep theirs, older files use their own time', () => {
  const prev = { generatedAt: '2026-11-02T17:25:46Z', events: [{ id: 'a', firstSeen: '2026-11-01T00:00:00Z' }, { id: 'b' }] };
  const evs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assignFirstSeen(evs, prev, '2026-11-02T20:00:00Z');
  assert.deepEqual(evs.map((e) => e.firstSeen), ['2026-11-01T00:00:00Z', '2026-11-02T17:25:46Z', '2026-11-02T20:00:00Z']);
});

console.log(`\n${passed} checks passed`);
