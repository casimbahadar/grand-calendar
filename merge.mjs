// Grand Calendar: merge duplicate listings into one result. Browser-safe.
//
// Two listings are the same event only when ALL of these hold:
//   same date, same start time (or both "time not listed"),
//   near-identical titles (after ignoring case, quotes, punctuation and "Copy of"),
//   and no conflicting town.
// Different times stay separate (two shows of one comedy night are two events).
// Within one source, different venues stay separate too.

const STOP = new Set(['the', 'a', 'an', 'at', 'and', 'with', 'of', 'in', 'for', 'on', 'to']);

export function titleTokens(t) {
  return new Set(t.toLowerCase()
    .replace(/^\s*copy of\s+/, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w)));
}

function similarity(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

const venueOf = (e) => (e.venue || (e.location || '').split(/,| - /)[0]).toLowerCase().trim();
const placeOf = (e) => (e.derived?.region?.status === 'in' || e.derived?.region?.status === 'out' ? e.derived.region.place : null);

export function sameEvent(a, b) {
  if (a.start.date !== b.start.date) return false;
  const ta = a.derived?.timeListed ? a.start.time : null;
  const tb = b.derived?.timeListed ? b.start.time : null;
  if (ta !== tb) return false;
  const pa = placeOf(a); const pb = placeOf(b);
  if (pa && pb && pa !== pb) return false;
  // Within one source, the venue must match too: the library runs the same program
  // at two branches at the same time, and those are two events.
  if (a.source === b.source && venueOf(a) !== venueOf(b)) return false;
  return similarity(titleTokens(a.title), titleTokens(b.title)) >= 0.8;
}

// Which listing leads: one with registration status, then one with more stated details.
function score(e) {
  return (e.registration ? 4 : 0) + (e.derived?.age ? 2 : 0) + (e.cost ? 1 : 0) + (e.end ? 1 : 0)
    + (/^\s*copy of/i.test(e.title) ? -3 : 0);
}

// -> events, where a merged one has alsoListed: [{ source, url, id, title }]
export function mergeDuplicates(events) {
  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.start.date)) byDate.set(e.start.date, []);
    byDate.get(e.start.date).push(e);
  }
  const out = [];
  for (const group of byDate.values()) {
    const used = new Set();
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;
      const cluster = [group[i]];
      for (let j = i + 1; j < group.length; j++) {
        if (!used.has(j) && sameEvent(group[i], group[j])) { cluster.push(group[j]); used.add(j); }
      }
      if (cluster.length === 1) { out.push(group[i]); continue; }
      cluster.sort((x, y) => score(y) - score(x));
      const [lead, ...rest] = cluster;
      out.push({
        ...lead,
        alsoListed: rest.map((r) => ({ source: r.source, url: r.url, id: r.id, title: r.title })),
      });
    }
  }
  return out;
}
