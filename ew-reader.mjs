// Grand Calendar: reads Explore Waterloo Region's calendar feed on the phone.
// Explore Waterloo blocks GitHub's servers. Its structured API sends a malformed
// cross-site header that browsers reject, but its calendar (.ics) feed allows any site
// to read it, so the phone reads that, page by page. Runs in the browser.

import { parseICS, normalizeEvent, addDays } from './ical.mjs';

export const EW_SOURCE = {
  id: 'explore-waterloo',
  name: 'Explore Waterloo Region',
  venueKeyFromLocation: true,
  pageUrl: (n) => (n === 1
    ? 'https://explorewaterloo.ca/events/list/?ical=1'
    : `https://explorewaterloo.ca/events/list/page/${n}/?ical=1`),
};

// Each feed page holds 30 events but only about 12 are new (pages overlap), so 60 days
// takes about 32 pages. Two pages are fetched at a time, with a short pause between pairs.
// onPage(newEvents, pagesDone) is called as events arrive so the screen can fill in.
export async function fetchEw(fromDate, horizonDays = 60, { fetchFn = fetch, onPage = () => {}, maxPages = 45, together = 2, pauseMs = 400 } = {}) {
  const checkedAt = new Date().toISOString();
  const until = addDays(fromDate, horizonDays);
  const byId = new Map();
  let done = 0;
  let stop = false;
  for (let n = 1; n <= maxPages && !stop; n += together) {
    const nums = Array.from({ length: together }, (_, i) => n + i).filter((x) => x <= maxPages);
    const texts = await Promise.all(nums.map(async (p) => {
      const res = await fetchFn(EW_SOURCE.pageUrl(p));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Explore Waterloo returned HTTP ${res.status} on page ${p}`);
      return res.text();
    }));
    const fresh = [];
    let anyInRange = false;
    for (const text of texts) {
      if (text === null) { stop = true; continue; }
      const evs = parseICS(text).map((r) => normalizeEvent(r, EW_SOURCE, checkedAt)).filter(Boolean);
      if (evs.length === 0) { stop = true; continue; }
      for (const e of evs) {
        if (e.start.date > until) continue;
        anyInRange = true;
        if (!byId.has(e.id)) { byId.set(e.id, e); fresh.push(e); }
      }
      done++;
    }
    if (fresh.length) onPage(fresh, done);
    if (!anyInRange || fresh.length === 0) stop = true;
    if (!stop) await new Promise((r) => { setTimeout(r, pauseMs); });
  }
  return { events: [...byId.values()], checkedAt, pages: done };
}
