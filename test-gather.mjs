// Run with: node test-gather.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseICS, normalizeEvent, regionOf, disallowed, SOURCES } from './gather.mjs';

const text = await readFile(new URL('./explore-sample.ics', import.meta.url), 'utf8');
const source = SOURCES[0];
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

console.log(`\n${passed} checks passed`);
