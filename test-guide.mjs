// Run with: node test-guide.mjs   (waterloo-guide-sample.txt is copied from the real Fall 2026 guide)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readWaterlooGuide, parseDates, parseGuideAge } from './guide-waterloo.mjs';
import { readWellesleyPage, wellesleySeason, looseDates } from './guide-wellesley.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const r = readWaterlooGuide(await readFile(new URL('./waterloo-guide-sample.txt', import.meta.url), 'utf8'), 'x');
const P = (code) => r.programs.find((p) => p.code === code);

check('season and registration dates', () => {
  assert.equal(r.season, 'FALL'); assert.equal(r.year, 2026);
  assert.match(r.registrationOpens, /Aug 18/);
});
check('Kid Artists row matches the guide', () => {
  const p = P('103626');
  assert.equal(p.title, 'Kid Artists – Fall Harvest (4 to 6 years)');
  assert.deepEqual([p.facilityCode, p.sessions, p.fee, p.days], ['RIM', 8, '$81.60', 'Thu']);
  assert.deepEqual(p.start, { date: '2026-10-01', time: '17:30' });
  assert.deepEqual(p.end, { date: '2026-11-19', time: '18:15' });
  assert.deepEqual([p.derived.age.min, p.derived.age.max], [4, 6]);
});
check('a wrapped title joins, the REMINDER box is not read as a title', () => {
  assert.equal(P('103689').title, 'Kid Outdoor Explorers – Survival Skills (4 to 6 years)');
  assert.ok(!r.programs.some((p) => /REMINDER|parent\/guardian/.test(p.title)));
});
check('second price line is kept with its group', () => {
  assert.match(P('103264').otherFees, /\$90\.62 - Child\/Youth\/55\+/);
});
check('instructor-only group keeps the program title', () => {
  assert.equal(P('103233').title, 'Boot Camp – All Levels');
  assert.equal(P('103233').instructor, 'Kurtis');
  assert.equal(P('104542').instructor, 'Brittany');
});
check('reading stops at the Drop-in section', () => assert.ok(r.programs.every((p) => ['Preschool', 'Adult'].includes(p.section))));
check('dates: fall guide puts January in the next year', () => {
  assert.deepEqual(parseDates('Dec 28', 'FALL', 2026), { start: '2026-12-28', end: '2026-12-28' });
  assert.deepEqual(parseDates('Jan 2', 'FALL', 2026), { start: '2027-01-02', end: '2027-01-02' });
  assert.deepEqual(parseDates('Sep 29-Nov 17', 'FALL', 2026), { start: '2026-09-29', end: '2026-11-17' });
});
check('ages as printed in titles', () => {
  assert.deepEqual(parseGuideAge('Little Artists (2.5 to 4 years with caregiver)'), { kind: 'range', min: 2.5, max: 4, text: '2.5 to 4 years with caregiver', how: 'stated', caregiver: true });
  assert.deepEqual([parseGuideAge('Parent and Baby Waterfit (3 months to 3 years)').min, parseGuideAge('Parent and Baby Waterfit (3 months to 3 years)').max], [0.25, 3]);
  assert.equal(parseGuideAge('Aqua Cycle Waterfit (16+)').min, 16);
  assert.equal(parseGuideAge('Barre – All Levels'), null);
});
check('each registration code appears once', () => assert.equal(new Set(r.programs.map((p) => p.code)).size, r.programs.length));
// ---------- Township of Wellesley page (saved copy of the real page, Nov 2026) ----------
const wHtml = await readFile(new URL('./wellesley-page-sample.html', import.meta.url), 'utf8');
const w = readWellesleyPage(wHtml, '2026-11-03T12:00:00Z');
const W = (t) => w.find((p) => p.title === t);
check('Wellesley: programs read, info-only sections left out, repeats kept once', () => {
  assert.ok(w.length >= 25, `only ${w.length}`);
  assert.equal(w.filter((p) => p.title === 'Chair Yoga+').length, 1);
  assert.ok(!w.some((p) => /Transfers/.test(p.title)));
  assert.equal(wellesleySeason(wHtml), 'Fall session');
});
check('Wellesley: schedule lines and both session links for Dance Sculpt', () => {
  const p = W('Dance Sculpt');
  assert.ok(p.schedule.includes('Mondays 6:30pm-7:30pm'));
  assert.equal(p.registerLinks.length, 2);
  assert.match(p.registerLinks[1].label, /Session 2: November 2nd/);
  assert.equal(p.facility, 'St. Clements CC');
  assert.deepEqual([p.start.date, p.end.date], ['2026-09-07', '2026-12-18']); // spans both sessions
});
check('Wellesley: long sentences stay in the description, dates worked out with the year labelled', () => {
  const a = W('Artshine');
  assert.ok(a.schedule.every((l) => l.length <= 90));
  assert.deepEqual([a.start.date, a.end.date], ['2026-10-10', '2026-11-28']);
  assert.ok(a.derived.notes.some((n) => /doesn't print the year/.test(n)));
  assert.equal(a.derived.age.kind, 'all-ages');
});
check('loose dates: a winter session read in the fall goes to next year', () => {
  assert.deepEqual(looseDates('January 12th - March 2nd', '2026-11-03T00:00:00Z'), { start: '2027-01-12', end: '2027-03-02', text: 'January 12th - March 2nd' });
  assert.deepEqual(looseDates('November 2nd - December 18th', '2026-11-03T00:00:00Z').end, '2026-12-18');
});
console.log(`\n${passed} guide checks passed`);
