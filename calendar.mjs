// Grand Calendar: which days each saved item happens on.
// Only stated days are used: an event's own dates, a program's stated weekdays between its
// stated first and last dates, or a one-day program's single date. Anything without a
// clearly stated day and date range is returned in `unplaced` instead of being guessed.

import { looseDates } from './guide-wellesley.mjs';

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };

// Waterloo guide day codes: "Thu", "Sat/Sun", "MonFri" (Monday to Friday), "ThuSun" (Thursday and Sunday)
export function guideWeekdays(code) {
  const parts = (code.match(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/g) || []).map((d) => DAY_INDEX[d.toLowerCase()]);
  if (/^MonFri$/.test(code)) return [1, 2, 3, 4, 5];
  return [...new Set(parts)];
}

// Wellesley schedule lines: "Thursdays 7:15-8:15pm", "Monday Evenings • 6:30–8:00 PM".
// A plural weekday ("Thursdays") or "<day> evenings/afternoons/nights" means every week.
export function weeklyDaysFromLines(lines) {
  const found = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(/\b(mon|tues|wednes|thurs|fri|satur|sun)(days\b|day (?:evenings|afternoons|mornings|nights)\b)/gi)) {
      found.add(DAY_INDEX[m[1].slice(0, 3).toLowerCase()]);
    }
  }
  return [...found];
}

const timeFromLine = (l) => (/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(l) || [])[1] || null;

function datesBetween(start, end, weekdays, cap = 400) {
  const out = [];
  for (let d = start, i = 0; d <= end && i < cap; d = addDays(d, 1), i++) {
    if (!weekdays || weekdays.includes(dateOf(d).getDay())) out.push(d);
  }
  return out;
}

// Your own entries: one day, or chosen weekdays between a first and last date.
export function validateCustom(c) {
  if (!c.title || !c.title.trim()) return 'Give it a name.';
  if (c.start && c.end && c.end <= c.start) return 'The end time is before the start time.';
  if (c.repeat === 'once') return c.date ? null : 'Pick the date.';
  if (c.repeat === 'dates') return Array.isArray(c.dates) && c.dates.length && c.dates.length <= 400 && c.dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) ? null : 'This entry has no usable dates.';
  if (!c.weekdays || !c.weekdays.length) return 'Pick at least one day of the week.';
  if (!c.first || !c.last) return 'Pick the first and last class dates.';
  if (c.last < c.first) return 'The last class is before the first one.';
  if (dateOf(c.last) - dateOf(c.first) > 400 * 86400000) return 'That runs over a year. Pick a last date within about a year.';
  if (!datesBetween(c.first, c.last, c.weekdays).length) return 'None of those weekdays fall between the first and last dates.';
  return null;
}

// item: { kind: 'event', e } or { kind: 'program', sessions: [p, ...] } or { kind: 'custom', c }
export function occurrences(item) {
  if (item.kind === 'custom') {
    const c = item.c;
    const days = c.repeat === 'once' ? (c.date ? [c.date] : []) : c.repeat === 'dates' ? [...c.dates] : datesBetween(c.first, c.last, c.weekdays);
    return { dates: days.map((date) => ({ date, time: c.start || null, endTime: c.end || null })), unplaced: days.length ? null : 'No dates set.' };
  }
  if (item.kind === 'event') {
    const e = item.e;
    const start = e.start?.date; if (!start) return { dates: [], unplaced: 'No date listed.' };
    const end = e.end?.date && e.end.date > start ? e.end.date : start;
    const timeText = e.derived?.timeListed && e.start.time ? e.start.time : null;
    return { dates: datesBetween(start, end, null).map((date) => ({ date, time: date === start ? timeText : null, multiDay: end !== start })), unplaced: null };
  }
  const dates = [];
  let unplaced = null;
  for (const p of item.sessions) {
    if (!p.start?.date) { unplaced = 'The source doesn\'t give dates, so it isn\'t placed on the calendar.'; continue; }
    const single = p.start.date === p.end?.date;
    if (p.days) { // City of Waterloo guide
      const wd = single ? null : guideWeekdays(p.days);
      for (const date of datesBetween(p.start.date, p.end.date, wd)) dates.push({ date, time: p.start.time, code: p.code, session: p });
      continue;
    }
    if (p.schedule) { // Township of Wellesley page
      if (single) { dates.push({ date: p.start.date, timeText: p.schedule.map(timeFromLine).find(Boolean) || null, session: p }); continue; }
      const wd = weeklyDaysFromLines(p.schedule);
      if (!wd.length) { unplaced = 'The township doesn\'t state a weekday for this, so it isn\'t placed on the calendar.'; continue; }
      const dayLine = p.schedule.find((l) => weeklyDaysFromLines([l]).length);
      // Use each listed session's own dates ("Session 1: Sept 7th-Oct 23rd"), so weeks between sessions stay empty.
      const ranges = p.schedule.map((l) => looseDates(l, p.lastChecked || `${p.start.date}T12:00:00Z`)).filter(Boolean);
      const spans = ranges.length ? ranges : [{ start: p.start.date, end: p.end.date }];
      const seen = new Set();
      for (const r of spans) for (const date of datesBetween(r.start, r.end, wd)) {
        if (!seen.has(date)) { seen.add(date); dates.push({ date, timeText: timeFromLine(dayLine || ''), session: p }); }
      }
    }
  }
  dates.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
  return { dates, unplaced: dates.length ? null : unplaced || 'No dates to place.' };
}

// The 42 days (6 weeks, Sunday first) shown for the month containing `iso`.
export function monthGrid(iso) {
  const d = dateOf(iso);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = isoOf(new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay()));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
export const weekOf = (iso) => { const s = addDays(iso, -dateOf(iso).getDay()); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); };
