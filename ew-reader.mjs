// Grand Calendar: reads Explore Waterloo Region's structured events API.
// Explore Waterloo blocks GitHub's servers but allows browsers to read this API,
// so the phone app fetches it directly. Output matches the GitHub job's event shape.
// No Node-only features: runs in the browser.

import { decodeEntities, htmlToText, regionOf, applyTimeRules } from './core.mjs';
import { readAges } from './ages.mjs';

export const EW_SOURCE = { id: 'explore-waterloo', name: 'Explore Waterloo Region' };
const DESC_MAX = 1000;
const API = 'https://explorewaterloo.ca/wp-json/tribe/events/v1/events';

// "2026-11-24 20:00:00" (site time, America/Toronto) -> { date, time }
function splitLocal(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
  return m ? { date: m[1], time: `${m[2]}:${m[3]}` } : null;
}

export function normalizeEw(raw, checkedAt) {
  const title = raw.title ? decodeEntities(raw.title).replace(/\s+/g, ' ').trim() : null;
  const s = splitLocal(raw.start_date);
  if (!raw.id || !title || !s) return null;
  const notes = [];
  if (raw.timezone && raw.timezone !== 'America/Toronto') notes.push(`Source time zone is ${raw.timezone}; time shown as given.`);

  const allDay = raw.all_day === true;
  const start = { date: s.date, time: allDay ? null : s.time, allDay };
  const e0 = splitLocal(raw.end_date);
  let end = e0 ? { date: e0.date, time: allDay ? null : e0.time, allDay } : null;
  if (allDay && end && end.date === start.date) end = null;
  const timed = allDay ? { end, timeListed: false } : applyTimeRules(start, end, notes);

  const fullText = htmlToText(raw.description || '');
  const age = readAges(title, fullText);
  const description = fullText.length > DESC_MAX ? fullText.slice(0, DESC_MAX) : fullText;

  const v = raw.venue && !Array.isArray(raw.venue) ? raw.venue : null;
  const venueName = v?.venue ? decodeEntities(v.venue).trim() : null;
  const city = v?.city ? decodeEntities(v.city).trim() : null;
  const location = [venueName, v?.address && decodeEntities(v.address).trim(), city, v?.province, v?.zip]
    .filter(Boolean).join(', ') || null;
  let region = city ? regionOf(city) : { status: 'unknown' };
  if (region.status === 'in' || region.status === 'out') region = { ...region, how: 'city field in source' };
  else region = regionOf(location);
  const lat = Number(v?.geo_lat); const lng = Number(v?.geo_lng);

  const url = typeof raw.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url : null;
  const cost = typeof raw.cost === 'string' && raw.cost.trim() ? decodeEntities(raw.cost).trim() : null;

  return {
    id: `${EW_SOURCE.id}:${raw.id}`,
    source: EW_SOURCE.id,
    title,
    description,
    descriptionTruncated: fullText.length > DESC_MAX,
    url,
    location,
    venue: venueName,
    categories: (raw.categories || []).map((c) => decodeEntities(c.name || '').trim()).filter(Boolean),
    status: null, // the API's "status" is the web page's publish state, not the event's
    cost,
    geo: Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null,
    start: { date: start.date, time: start.time },
    end: timed.end ? { date: timed.end.date, time: timed.end.time } : null,
    allDay,
    lastChecked: checkedAt,
    registration: null,
    derived: { region, timeListed: timed.timeListed, age, notes },
  };
}

// Fetch every page of events from `fromDate` to `toDate` (YYYY-MM-DD).
// onProgress(pageNumber, totalPages) lets the screen show a progress bar.
export async function fetchEw(fromDate, toDate, { fetchFn = fetch, onProgress = () => {}, perPage = 50, maxPages = 30 } = {}) {
  const checkedAt = new Date().toISOString();
  const out = new Map();
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, maxPages); page++) {
    const url = `${API}?per_page=${perPage}&page=${page}&start_date=${fromDate}&end_date=${toDate}`;
    const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Explore Waterloo returned HTTP ${res.status} on page ${page}`);
    const data = await res.json();
    totalPages = Number(data.total_pages) || 1;
    for (const raw of data.events || []) {
      if (raw.hide_from_listings) continue;
      const e = normalizeEw(raw, checkedAt);
      if (e && !out.has(e.id)) out.set(e.id, e);
    }
    onProgress(page, Math.min(totalPages, maxPages));
  }
  return { events: [...out.values()], checkedAt, truncated: totalPages > maxPages };
}
