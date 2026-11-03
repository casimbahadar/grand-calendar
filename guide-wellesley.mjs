// Grand Calendar: reads the Township of Wellesley's recreation programs page.
// The township lists each program in a collapsible section: a title, a description,
// then lines with the day and time, dates, place and a "Register Here" link.
// Schedule lines are kept exactly as written. Dates are only turned into calendar
// dates where the page gives month and day; the year isn't printed, so it's worked out
// from when the page was read (and labelled as such).

import { decodeEntities } from './core.mjs';
import { readAges } from './ages.mjs';

export const WELLESLEY = {
  id: 'wellesley-programs',
  name: 'Township of Wellesley recreation programs',
  page: 'https://www.wellesley.ca/recreation-parks-and-leisure/recreation-programs/',
};

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
const text = (h) => decodeEntities(h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ').trim();

// "October 10th - November 28th", "September 7th-October 23rd", "November 21st"
// -> ISO dates, choosing the year so the dates sit nearest to when the page was read.
export function looseDates(s, readAt) {
  const re = new RegExp(`${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|–|to)\\s*(?:${MONTH_RE}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?`, 'i');
  const m = re.exec(s);
  if (!m) return null;
  const ref = new Date(readAt);
  const refMonth = ref.getUTCMonth() + 1;
  const refYear = ref.getUTCFullYear();
  const m1 = MONTHS[m[1].toLowerCase().replace('.', '')]; const d1 = Number(m[2]);
  const m2 = m[3] ? MONTHS[m[3].toLowerCase().replace('.', '')] : m1; const d2 = m[4] ? Number(m[4]) : d1;
  // A month more than 4 months before the read date is taken as next year (a winter session read in fall).
  const y1 = m1 < refMonth - 4 ? refYear + 1 : refYear;
  const y2 = m2 < m1 ? y1 + 1 : y1;
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: iso(y1, m1, d1), end: iso(y2, m2, d2), text: m[0] };
}

const SCHEDULE_LINE = /^\p{Extended_Pictographic}|\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|^session \d|every month|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/iu;
const lineText = (h) => decodeEntities(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|ul)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
const stripEmoji = (l) => l.replace(/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+/u, '').trim();

// The page's current season, from its own wording ("Fall Session: Registration opens August 18th!")
export function wellesleySeason(html) {
  const m = /(Fall|Winter|Spring|Summer)(?:\/Summer)? Session/i.exec(html.replace(/<[^>]+>/g, ' '));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} session` : null;
}

export function readWellesleyPage(html, checkedAt) {
  const out = [];
  const seen = new Set();
  // Walk section headings and accordion tabs in page order; a tab's content runs to the next tab or heading.
  const marks = [...html.matchAll(/<p class="heading\s+base-heading\s*"\s*>([\s\S]*?)<\/p>|<a class="nav-link nav-button-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
  let section = null;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m[1] !== undefined) { section = text(m[1]); continue; }
    const title = text(m[2]);
    const body = html.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined);
    const lines = lineText(body).filter((l) => !/^(register here!?|details:?|workshop information:?|information:?)$/i.test(l));
    const links = [...body.matchAll(/<a[^>]+href="([^"]+activecommunities[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((x) => ({ url: x[1].replace(/&amp;/g, '&').replace(/^http:/, 'https:'), label: text(x[2]) }));
    // Schedule lines are short ("Thursdays 7:15-8:15pm"); long sentences that mention a day stay in the description.
    const isSchedule = (l) => SCHEDULE_LINE.test(l) && l.length <= 90;
    const schedule = lines.filter(isSchedule).map(stripEmoji).filter(Boolean);
    const description = lines.filter((l) => !isSchedule(l)).join(' ');
    if (!title || /^(help us improve|subscribe|program and workshop transfers)/i.test(title)) continue;
    // Info-only sections (no schedule and no registration link) are left out.
    if (!schedule.length && !links.length) continue;
    const key = `${title}|${schedule.join('|')}`;
    if (seen.has(key)) continue; // the page repeats some programs in two sections
    seen.add(key);
    // Several sessions ("Session 1: Sept 7-Oct 23", "Session 2: Nov 2-Dec 18"): span them all,
    // so a program isn't hidden as ended while a later session is still to come.
    const found = schedule.map((l) => looseDates(l, checkedAt)).filter(Boolean);
    const dates = found.length ? {
      start: found.map((d) => d.start).sort()[0],
      end: found.map((d) => d.end).sort().slice(-1)[0],
      text: found.map((d) => d.text).join('; '),
    } : null;
    out.push(entry({ title, section, description, schedule, register: links[0]?.url || null, sessions: links, dates, checkedAt }));
  }
  return out;
}

function entry({ title, section, description, schedule, register, sessions = [], dates, checkedAt }) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const place = schedule.concat(description).find((s) => /^[A-Z][\w.' ]*(Recreation Centre|Community Centre|CC|Arena|Complex|Youth Centre|Hall)\b/.test(s)) || null;
  const age = readAges(title, description);
  return {
    id: `${WELLESLEY.id}:${slug}`,
    source: WELLESLEY.id,
    kind: 'program',
    title,
    description,
    section,
    category: section,
    schedule,
    registerLinks: sessions,
    start: dates ? { date: dates.start, time: null } : null,
    end: dates ? { date: dates.end, time: null } : null,
    facility: place,
    location: place ? `${place}, Wellesley Township` : 'Wellesley Township',
    url: register ? register.replace(/^http:/, 'https:') : WELLESLEY.page,
    guideUrl: WELLESLEY.page,
    sourceName: 'Township of Wellesley',
    lastChecked: checkedAt,
    derived: {
      age,
      region: { status: 'in', place: 'Wellesley', how: 'Township of Wellesley program' },
      timeListed: false,
      notes: [
        'Read from the Township of Wellesley programs page. Days, times and dates are shown as the township wrote them.',
        ...(dates ? [`Calendar dates worked out from “${dates.text}”; the page doesn't print the year.`] : []),
      ],
    },
  };
}
