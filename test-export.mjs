// Run with: node test-export.mjs
import assert from 'node:assert/strict';
import { buildCalendarFile, parseTimeRange } from './export-ics.mjs';
import { readCalendarFile } from './ics-import.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const karate = { uid: 'waterloo-guide:103273', title: 'Kid Karate (4 to 6 years)', place: 'Waterloo Memorial Recreation Complex', url: 'https://www.waterloo.ca/activewaterloo',
  days: ['2026-11-04', '2026-11-11', '2026-11-18'].map((date) => ({ date, start: '16:30', end: '17:00' })) };
const fair = { uid: 'ew:fair', title: 'Winter Fair; crafts, food', place: 'Elmira, ON', days: [{ date: '2026-11-28', start: null, end: null }] };

check('each class day becomes its own entry, with stable IDs and times', () => {
  const { text, count } = buildCalendarFile([karate], { from: '2026-11-01' });
  assert.equal(count, 3);
  assert.match(text, /UID:waterloo-guide:103273-20261111@grand-calendar/);
  assert.match(text, /DTSTART:20261104T163000\r\nDTEND:20261104T170000/);
});
check('days before "from" are left out (past classes)', () => {
  assert.equal(buildCalendarFile([karate], { from: '2026-11-10' }).count, 2);
});
check('all-day items, special characters and reminders', () => {
  const { text } = buildCalendarFile([fair], { reminderMinutes: 1440 });
  assert.match(text, /DTSTART;VALUE=DATE:20261128\r\nDTEND;VALUE=DATE:20261129/);
  assert.match(text, /SUMMARY:Winter Fair\\; crafts\\, food/);
  assert.match(text, /TRIGGER:-PT15H/);
  assert.match(buildCalendarFile([karate], { reminderMinutes: 60 }).text, /TRIGGER:-PT60M/);
  assert.ok(!/VALARM/.test(buildCalendarFile([karate]).text));
});
check('the file reads back correctly with the app\'s own importer', () => {
  const { text } = buildCalendarFile([karate, fair]);
  const r = readCalendarFile(text);
  const k = r.items.find((i) => i.title.startsWith('Kid Karate'));
  assert.deepEqual(k.dates, ['2026-11-04', '2026-11-11', '2026-11-18']);
  assert.deepEqual([k.start, k.end], ['16:30', '17:00']);
});
check('township time wording becomes times', () => {
  assert.deepEqual(parseTimeRange('Thursdays 7:15-8:15pm'), { start: '19:15', end: '20:15' });
  assert.deepEqual(parseTimeRange('Monday Evenings • 6:30–8:00 PM'), { start: '18:30', end: '20:00' });
  assert.deepEqual(parseTimeRange('10am-12pm'), { start: '10:00', end: '12:00' });
  assert.deepEqual(parseTimeRange('11-1pm'), { start: '11:00', end: '13:00' });
  assert.equal(parseTimeRange('4th Wednesday of every month'), null);
});
console.log(`\n${passed} export checks passed`);
