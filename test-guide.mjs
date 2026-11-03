// Run with: node test-guide.mjs   (waterloo-guide-sample.txt is copied from the real Fall 2026 guide)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readWaterlooGuide, parseDates, parseGuideAge } from './guide-waterloo.mjs';

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
console.log(`\n${passed} guide checks passed`);
