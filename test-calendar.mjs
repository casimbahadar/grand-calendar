// Run with: node test-calendar.mjs
import assert from 'node:assert/strict';
import { occurrences, guideWeekdays, weeklyDaysFromLines, monthGrid, weekOf, validateCustom } from './calendar.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

check('Waterloo weekly program lands on each stated weekday only', () => {
  // Kid Artists: Thu Oct 1 - Nov 19 2026, 8 classes (as printed in the guide)
  const p = { days: 'Thu', code: '103626', start: { date: '2026-10-01', time: '17:30' }, end: { date: '2026-11-19', time: '18:15' } };
  const { dates } = occurrences({ kind: 'program', sessions: [p] });
  assert.equal(dates.length, 8);
  assert.ok(dates.every((d) => new Date(`${d.date}T12:00`).getDay() === 4));
  assert.equal(dates[0].date, '2026-10-01'); assert.equal(dates.at(-1).date, '2026-11-19');
});
check('one-day program is placed once', () => {
  const p = { days: 'Fri', code: '103694', start: { date: '2026-11-20', time: '16:00' }, end: { date: '2026-11-20', time: '16:45' } };
  assert.deepEqual(occurrences({ kind: 'program', sessions: [p] }).dates.map((d) => d.date), ['2026-11-20']);
});
check('guide day codes', () => {
  assert.deepEqual(guideWeekdays('Sat/Sun'), [6, 0]);
  assert.deepEqual(guideWeekdays('MonFri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(guideWeekdays('ThuSun'), [4, 0]);
});
check('Wellesley weekly lines; monthly or unclear lines are not guessed', () => {
  assert.deepEqual(weeklyDaysFromLines(['Thursdays 7:15-8:15pm', 'Jen Machan']), [4]);
  assert.deepEqual(weeklyDaysFromLines(['Monday Evenings • 6:30–8:00 PM']), [1]);
  assert.deepEqual(weeklyDaysFromLines(['4th Wednesday of every month', '5:00 – 6:00pm']), []);
  const monthly = { schedule: ['4th Wednesday of every month', '5:00 – 6:00pm'], start: null, end: null };
  const r = occurrences({ kind: 'program', sessions: [monthly] });
  assert.equal(r.dates.length, 0); assert.ok(r.unplaced);
});
check('Wellesley Thursday Pilates: every Thursday across both sessions, with its time', () => {
  const p = { schedule: ['Thursdays 7:15-8:15pm', 'Jen Machan', 'Bill Gies Recreation Centre', 'Session 1: September 7th-October 23rd', 'Session 2: November 2nd - December 18th'], start: { date: '2026-09-07', time: null }, end: { date: '2026-12-18', time: null }, lastChecked: '2026-11-03T12:00:00Z' };
  const { dates } = occurrences({ kind: 'program', sessions: [p] });
  assert.ok(dates.every((d) => new Date(`${d.date}T12:00`).getDay() === 4));
  assert.equal(dates[0].date, '2026-09-10'); assert.equal(dates.at(-1).date, '2026-12-17');
  assert.equal(dates[0].timeText, '7:15-8:15pm');
  assert.ok(!dates.some((d) => d.date === '2026-10-29'), 'Thursday between the two sessions must stay empty');
  assert.equal(dates.length, 7 + 7); // 7 Thursdays in Sept 10-Oct 22, 7 in Nov 5-Dec 17
});
check('multi-day event appears on each of its days; placeholder times stay unlisted', () => {
  const e = { start: { date: '2026-11-27', time: '00:00' }, end: { date: '2026-11-29', time: '23:59' }, derived: { timeListed: false } };
  const { dates } = occurrences({ kind: 'event', e });
  assert.deepEqual(dates.map((d) => d.date), ['2026-11-27', '2026-11-28', '2026-11-29']);
  assert.ok(dates.every((d) => d.time === null));
});
check('month grid starts on Sunday and covers 6 weeks; week runs Sunday to Saturday', () => {
  const g = monthGrid('2026-11-15');
  assert.equal(g.length, 42); assert.equal(g[0], '2026-11-01'); // Nov 1 2026 is a Sunday
  assert.deepEqual([weekOf('2026-11-04')[0], weekOf('2026-11-04')[6]], ['2026-11-01', '2026-11-07']);
  assert.equal(monthGrid('2026-12-10')[0], '2026-11-29');
});
check('your own weekly entry: every chosen weekday between first and last', () => {
  const c = { title: 'Swim lessons', repeat: 'weekly', weekdays: [2, 4], first: '2026-11-03', last: '2026-11-26', start: '17:30', end: '18:00' };
  assert.equal(validateCustom(c), null);
  const { dates } = occurrences({ kind: 'custom', c });
  assert.deepEqual(dates.map((d) => d.date), ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19', '2026-11-24', '2026-11-26']);
  assert.equal(dates[0].time, '17:30');
});
check('your own entry: problems are explained, not saved', () => {
  assert.match(validateCustom({ title: '', repeat: 'once', date: '2026-11-05' }), /name/);
  assert.match(validateCustom({ title: 'x', repeat: 'weekly', weekdays: [], first: '2026-11-01', last: '2026-11-30' }), /day of the week/);
  assert.match(validateCustom({ title: 'x', repeat: 'weekly', weekdays: [1], first: '2026-11-30', last: '2026-11-01' }), /before the first/);
  assert.match(validateCustom({ title: 'x', repeat: 'weekly', weekdays: [6], first: '2026-11-02', last: '2026-11-06' }), /None of those weekdays/);
  assert.match(validateCustom({ title: 'x', repeat: 'once', date: '2026-11-05', start: '18:00', end: '17:00' }), /end time/);
  assert.deepEqual(occurrences({ kind: 'custom', c: { title: 'x', repeat: 'once', date: '2026-11-05' } }).dates.map((d) => d.date), ['2026-11-05']);
});
console.log(`\n${passed} calendar checks passed`);
