// Grand Calendar: reads a calendar file (.ics) you bring in, for example the one an
// ActiveNet registration receipt links to. Each class or event becomes one of your own
// entries, with its exact dates. Repeat rules are expanded here; anything this reader
// doesn't understand is reported, never guessed.

import { unescapeText, parseDT } from './ical.mjs';

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (iso, n) => { const d = dOf(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
const MAX_DATES = 400;

// Like parseICS, but keeps every EXDATE and RDATE line (a file can have several).
function parseEvents(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const unfolded = [];
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  const events = []; let cur = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') { cur = { EXDATE: [], RDATE: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (i < 0) continue;
    const [name, ...paramParts] = line.slice(0, i).split(';');
    const params = Object.fromEntries(paramParts.map((p) => { const e = p.indexOf('='); return [p.slice(0, e).toUpperCase(), p.slice(e + 1).replace(/^"|"$/g, '')]; }));
    const value = line.slice(i + 1);
    const key = name.toUpperCase();
    if (key === 'EXDATE' || key === 'RDATE') cur[key].push(...value.split(',').map((v) => ({ value: v, params })));
    else if (!cur[key]) cur[key] = { value, params };
  }
  return events;
}

// Expand a repeat rule into dates. Supports what registration systems use for classes:
// FREQ=WEEKLY or DAILY, with INTERVAL, BYDAY, UNTIL or COUNT. Returns null if unsupported.
export function expandRule(startDate, rule) {
  const r = Object.fromEntries(rule.split(';').map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ;
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return null;
  if (r.BYMONTH || r.BYMONTHDAY || r.BYSETPOS || r.BYYEARDAY || r.BYWEEKNO) return null;
  const interval = Number(r.INTERVAL || 1);
  const until = r.UNTIL ? parseDT(r.UNTIL.length === 8 ? r.UNTIL : r.UNTIL, {})?.date : null;
  const count = r.COUNT ? Number(r.COUNT) : null;
  if (!until && !count) return null; // never-ending repeats can't be placed honestly
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.replace(/^[+-]?\d+/, '')]) : null;
  if (byDay && byDay.some((d) => d === undefined)) return null;
  const startDow = dOf(startDate).getUTCDay();
  const weekStart = addDays(startDate, -startDow); // Sunday of the first week
  const out = [];
  for (let i = 0; i < 3660 && out.length < MAX_DATES; i++) {
    const d = addDays(startDate, i);
    if (until && d > until) break;
    if (freq === 'DAILY') { if (i % interval === 0) out.push(d); }
    else {
      const weekIndex = Math.floor((dOf(d) - dOf(weekStart)) / (7 * 86400000));
      const days = byDay || [startDow];
      if (weekIndex % interval === 0 && days.includes(dOf(d).getUTCDay())) out.push(d);
    }
    if (count && out.length >= count) break;
  }
  return out;
}

export function readCalendarFile(text) {
  if (!/BEGIN:VCALENDAR/.test(text)) return { items: [], skipped: [{ title: 'This file', why: 'It isn\'t a calendar file.' }] };
  const groups = new Map();
  const skipped = [];
  for (const ev of parseEvents(text)) {
    const title = ev.SUMMARY ? unescapeText(ev.SUMMARY.value).trim() : '';
    if (!ev.DTSTART) { skipped.push({ title: title || 'An event', why: 'No start date.' }); continue; }
    const start = parseDT(ev.DTSTART.value, ev.DTSTART.params);
    const end = ev.DTEND ? parseDT(ev.DTEND.value, ev.DTEND.params) : null;
    if (!start) { skipped.push({ title: title || 'An event', why: 'Its start date couldn\'t be read.' }); continue; }
    if (start.tzid && !/Toronto|Eastern|^EST|^EDT/i.test(start.tzid)) { skipped.push({ title, why: `Its times are in another time zone (${start.tzid}).` }); continue; }
    let dates = [start.date];
    if (ev.RRULE) {
      const expanded = expandRule(start.date, ev.RRULE.value);
      if (!expanded) { skipped.push({ title, why: 'Its repeat pattern isn\'t one Grand Calendar can read, so it wasn\'t guessed.' }); continue; }
      dates = expanded;
    }
    for (const r of ev.RDATE) { const d = parseDT(r.value, r.params); if (d) dates.push(d.date); }
    const ex = new Set(ev.EXDATE.map((x) => parseDT(x.value, x.params)?.date).filter(Boolean));
    dates = dates.filter((d) => !ex.has(d));
    if (ev.STATUS && /CANCELLED/i.test(ev.STATUS.value)) { skipped.push({ title, why: 'Marked as cancelled in the file.' }); continue; }
    const place = ev.LOCATION ? unescapeText(ev.LOCATION.value).replace(/\s+/g, ' ').trim() : '';
    const key = `${title}|${place}|${start.time || ''}|${end?.time || ''}`;
    if (!groups.has(key)) {
      let url = null;
      try { const u = new URL(ev.URL?.value || ''); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href; } catch { /* none */ }
      groups.set(key, { title: title || 'Untitled', place, start: start.allDay ? null : start.time, end: end && !end.allDay && end.date === start.date ? end.time : null, url, dates: new Set() });
    }
    for (const d of dates) groups.get(key).dates.add(d);
  }
  const items = [...groups.values()].map((g) => ({ ...g, dates: [...g.dates].sort().slice(0, MAX_DATES) })).filter((g) => g.dates.length);
  return { items, skipped };
}
