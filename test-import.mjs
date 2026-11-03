// Run with: node test-import.mjs
// The samples are written to match the Dungeons & Dragons receipt (Fridays, Sep 19 to
// Dec 12, 2025, 7 to 9 pm, Huron Community Centre) in the two ways calendar files commonly
// describe a weekly class. The real ActiveNet file still needs checking against these.
import assert from 'node:assert/strict';
import { readCalendarFile, expandRule } from './ics-import.mjs';
import { occurrences, validateCustom } from './calendar.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}END:VCALENDAR\r\n`;
const FRIDAYS = ['2025-09-19', '2025-09-26', '2025-10-03', '2025-10-10', '2025-10-17', '2025-10-24', '2025-10-31', '2025-11-07', '2025-11-14', '2025-11-21', '2025-11-28', '2025-12-05', '2025-12-12'];

check('weekly repeat rule: 13 Fridays, 7 to 9 pm, with place', () => {
  const r = readCalendarFile(wrap('BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Dungeons & Dragons\r\nLOCATION:HCC EO Meeting Room at Huron Community Centre\\, 80 Tartan Ave.\\, Kitchener\r\nDTSTART;TZID=America/Toronto:20250919T190000\r\nDTEND;TZID=America/Toronto:20250919T210000\r\nRRULE:FREQ=WEEKLY;UNTIL=20251212T235959Z;BYDAY=FR\r\nEND:VEVENT\r\n'));
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.deepEqual(it.dates, FRIDAYS);
  assert.deepEqual([it.start, it.end], ['19:00', '21:00']);
  assert.equal(it.place, 'HCC EO Meeting Room at Huron Community Centre, 80 Tartan Ave., Kitchener');
});
check('one event per class date is grouped into one entry', () => {
  const body = FRIDAYS.map((d, i) => `BEGIN:VEVENT\r\nUID:x${i}\r\nSUMMARY:Dungeons & Dragons\r\nDTSTART:${d.replace(/-/g, '')}T190000\r\nDTEND:${d.replace(/-/g, '')}T210000\r\nEND:VEVENT\r\n`).join('');
  const r = readCalendarFile(wrap(body));
  assert.equal(r.items.length, 1); assert.deepEqual(r.items[0].dates, FRIDAYS);
});
check('skipped dates (EXDATE) are left out', () => {
  const r = readCalendarFile(wrap('BEGIN:VEVENT\r\nSUMMARY:Swim\r\nDTSTART;TZID=America/Toronto:20251104T173000\r\nDTEND;TZID=America/Toronto:20251104T180000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=America/Toronto:20251111T173000\r\nEND:VEVENT\r\n'));
  assert.deepEqual(r.items[0].dates, ['2025-11-04', '2025-11-18', '2025-11-25']);
});
check('UTC times are shown in Toronto time', () => {
  const r = readCalendarFile(wrap('BEGIN:VEVENT\r\nSUMMARY:Class\r\nDTSTART:20251121T000000Z\r\nDTEND:20251121T020000Z\r\nEND:VEVENT\r\n'));
  assert.deepEqual([r.items[0].dates[0], r.items[0].start, r.items[0].end], ['2025-11-20', '19:00', '21:00']);
});
check('patterns it can\'t read are reported, not guessed', () => {
  const r = readCalendarFile(wrap('BEGIN:VEVENT\r\nSUMMARY:Monthly club\r\nDTSTART:20251105T190000\r\nRRULE:FREQ=MONTHLY;BYDAY=1WE\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Forever\r\nDTSTART:20251105T190000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n'));
  assert.equal(r.items.length, 0); assert.equal(r.skipped.length, 2);
  assert.ok(r.skipped.every((s) => /repeat pattern/.test(s.why)));
  assert.equal(readCalendarFile('hello').items.length, 0);
});
check('an imported entry places exactly its dates on the calendar', () => {
  const c = { title: 'Dungeons & Dragons', repeat: 'dates', dates: FRIDAYS, start: '19:00', end: '21:00' };
  assert.equal(validateCustom(c), null);
  assert.deepEqual(occurrences({ kind: 'custom', c }).dates.map((d) => d.date), FRIDAYS);
  assert.deepEqual(expandRule('2025-09-01', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3'), ['2025-09-01', '2025-09-15', '2025-09-29']);
});
console.log(`\n${passed} import checks passed`);
