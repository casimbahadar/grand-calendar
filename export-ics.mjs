// Grand Calendar: one calendar file with everything on "Your calendar", for iPhone Calendar.
// Each class or event day becomes its own calendar entry with a stable ID, so adding the
// file again updates entries rather than piling up copies where the calendar app supports it.
// Times are written as local times (the same way single events already are).

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const d8 = (iso) => iso.replace(/-/g, '');
const t6 = (hhmm) => `${hhmm.replace(':', '')}00`;
const nextDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + 1)); return x.toISOString().slice(0, 10); };
// Long lines are folded at 75 characters, as calendar files require.
const fold = (line) => { const out = []; let s = line; while (s.length > 75) { out.push(s.slice(0, 75)); s = ` ${s.slice(75)}`; } out.push(s); return out.join('\r\n'); };

// "7:15-8:15pm", "6:30–8:00 PM", "10am-12pm" -> { start: "19:15", end: "20:15" }
export function parseTimeRange(text) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text || '');
  if (!m) return null;
  const to24 = (h, min, ap) => { let hh = Number(h) % 12; if (ap.toLowerCase() === 'pm') hh += 12; return `${String(hh).padStart(2, '0')}:${min || '00'}`; };
  const endAp = m[6]; const startAp = m[3] || endAp;
  let start = to24(m[1], m[2], startAp); const end = to24(m[4], m[5], endAp);
  if (!m[3] && start > end) start = to24(m[1], m[2], startAp === 'pm' ? 'am' : 'pm'); // "11-1pm"
  return { start, end };
}

// entries: [{ uid, title, place, url, note, days: [{ date, start, end }] }]
// start/end are "HH:MM" or null (null start = all-day)
export function buildCalendarFile(entries, { from, reminderMinutes = 0, now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Grand Calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Grand Calendar'];
  let count = 0;
  for (const e of entries) {
    for (const day of e.days) {
      if (from && day.date < from) continue;
      lines.push('BEGIN:VEVENT', `UID:${e.uid}-${d8(day.date)}@grand-calendar`, `DTSTAMP:${stamp}`);
      if (!day.start) lines.push(`DTSTART;VALUE=DATE:${d8(day.date)}`, `DTEND;VALUE=DATE:${d8(nextDay(day.date))}`);
      else {
        lines.push(`DTSTART:${d8(day.date)}T${t6(day.start)}`);
        if (day.end && day.end > day.start) lines.push(`DTEND:${d8(day.date)}T${t6(day.end)}`); else lines.push('DURATION:PT1H');
      }
      lines.push(fold(`SUMMARY:${esc(e.title)}`));
      if (e.place) lines.push(fold(`LOCATION:${esc(e.place)}`));
      if (e.url) lines.push(fold(`URL:${e.url}`));
      const note = [day.start && !(day.end && day.end > day.start) ? 'End time not listed; 1 hour used.' : '', !day.start ? 'Time not listed.' : '', e.note || ''].filter(Boolean).join(' ');
      if (note) lines.push(fold(`DESCRIPTION:${esc(note)}`));
      if (reminderMinutes > 0) {
        // All-day items are reminded at 9 am the day before when a day's notice is chosen.
        const trig = !day.start ? (reminderMinutes >= 1440 ? '-PT15H' : 'PT9H') : `-PT${reminderMinutes}M`;
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(e.title)}`), `TRIGGER:${trig}`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
      count++;
    }
  }
  lines.push('END:VCALENDAR');
  return { text: lines.join('\r\n') + '\r\n', count };
}
