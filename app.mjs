// Grand Calendar app. Plain ES module, no build step.
// Source text is only ever inserted as text (never as HTML), so a listing can't inject code.

import { occurrences, monthGrid, weekOf, addDays as calAddDays, validateCustom } from './calendar.mjs';
import { readCalendarFile } from './ics-import.mjs';
import { fetchEw } from './ew-reader.mjs';
import { suitabilityOf } from './suitability.mjs';
import { TOPICS, topicsOf, searchMatch } from './topics.mjs';
import { mergeDuplicates } from './merge.mjs';

// ---------- Storage (namespaced: other apps share this github.io address) ----------
const NS = 'grandcal:';
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(NS + k, JSON.stringify(v)); return true; } catch {
      toast('Could not save on this phone. Storage may be full or turned off.');
      return false;
    }
  },
};

const EW_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PHONE_LOOKUPS_PER_VISIT = 3; // new venues looked up on OpenStreetMap per app open
const SOURCE_NAMES = { wpl: 'Waterloo Public Library', 'explore-waterloo': 'Explore Waterloo Region' };

const state = {
  events: [],          // merged, ready to filter
  notices: [],         // closure notices, shown under their day
  venues: {},
  geoCache: store.get('geo', {}),
  status: [],
  dates: '2w', from: null, to: null,
  who: 'everyone',
  topics: new Set(),
  q: '',
  cost: 'any', setting: 'any', reg: 'any', hideFull: false, radius: '',
  loc: store.get('loc', null),
  kid: store.get('kid', { min: 5, max: 6 }),
  saved: store.get('saved', {}),
  prevVisit: store.get('visit', null),
  expanded: new Set(),
  view: 'events',
  programs: [],            // program sessions from programs.json
  programsReady: null,     // null = loading, true, or an error message
  pq: '', pwho: 'everyone', pUpcoming: false,
  providers: [], provType: null, provQ: '', provWho: 'everyone', provTown: '', provOpen: new Set(),
  calView: 'month',        // month | week | list (remembered)
  calDay: null,            // selected day in the calendar, ISO
  calOpen: null,           // calendar entry opened to show its full card
};

// ---------- Small helpers ----------
const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function fmtTime(t) {
  const [hh, mm] = t.split(':').map(Number);
  const suffix = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 || 12;
  return { text: mm ? `${h12}:${pad(mm)}` : `${h12}`, suffix };
}
function fmtWhen(e) {
  if (!e.derived.timeListed) return e.allDay ? 'All day' : 'Time not listed';
  const s = fmtTime(e.start.time);
  if (e.end && e.end.date === e.start.date && e.end.time) {
    const en = fmtTime(e.end.time);
    return s.suffix === en.suffix ? `${s.text} to ${en.text} ${en.suffix}` : `${s.text} ${s.suffix} to ${en.text} ${en.suffix}`;
  }
  return `${s.text} ${s.suffix}`;
}
function fmtClock(iso) {
  if (!iso) return 'at an unknown time';
  const d = new Date(iso);
  const t = fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  const clock = `${t.text} ${t.suffix}`;
  return isoOf(d) === isoOf(new Date()) ? `at ${clock}` : `${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} at ${clock}`;
}
function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  const days = Math.round(hrs / 24);
  return hrs < 24 ? `${hrs} hour${hrs === 1 ? '' : 's'} ago` : `${days} day${days === 1 ? '' : 's'} ago`;
}
function dayLabel(iso) {
  const today = isoOf(new Date());
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  return dateOf(iso).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
}
function km(a, b) {
  const R = 6371; const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

let toastTimer = null;
function toast(msg, action = null) {
  const t = $('toast');
  // An open Settings or Filters panel sits above the page, so the message must live inside it to be seen.
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.append(t);
  t.replaceChildren(h('span', { text: msg }));
  if (action) t.append(' ', h('button', { type: 'button', class: 'btn quiet', text: action.label, onclick: () => { action.run(); t.hidden = true; } }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ---------- Loading ----------
async function loadJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showProgress(on, text = '', frac = 0) {
  $('progress').hidden = !on;
  $('progress-text').textContent = text;
  $('progress-bar').value = frac;
}

async function loadEw(force, onEvents) {
  const cached = store.get('ew', null);
  const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < EW_MAX_AGE_MS;
  if (fresh && !force) return { events: cached.events, fetchedAt: cached.fetchedAt, ok: true, fromCache: true };
  let count = 0;
  try {
    showProgress(true, 'Loading Explore Waterloo events', 0.02);
    const r = await fetchEw(isoOf(new Date()), 60, {
      onPage: (fresh, pages) => {
        count += fresh.length;
        showProgress(true, `Loading Explore Waterloo: ${count} events so far`, Math.min(0.95, pages / 32));
        onEvents(fresh);
      },
    });
    showProgress(false);
    store.set('ew', { fetchedAt: r.checkedAt, events: r.events });
    return { events: r.events, fetchedAt: r.checkedAt, ok: true };
  } catch (err) {
    showProgress(false);
    return { events: cached?.events || [], fetchedAt: cached?.fetchedAt || null, ok: false, error: String(err.message || err) };
  }
}

// venues.json keys are "venue|street". Feed locations sometimes have extra commas
// ("Cambridge Public Library, Queen's Square, 1 North Square, ..."), so fall back to
// matching a listed venue name at the start of the location and its street inside it.
let venueList = [];
function venueCoords(e) {
  if (state.venues[e.venueKey]) return state.venues[e.venueKey];
  if (state.geoCache[e.venueKey]) return state.geoCache[e.venueKey];
  const loc = (e.location || '').toLowerCase();
  const hit = venueList.find(([name, street]) => loc.startsWith(name) && street && loc.includes(street));
  return hit ? hit[2] : null;
}

function prepare(e, firstSeen) {
  const out = { ...e };
  if (!out.firstSeen) out.firstSeen = firstSeen;
  if (!out.geo && out.venueKey) {
    const v = venueCoords(out);
    if (v) { out.geo = { lat: v.lat, lng: v.lng }; out.geoHow = 'venue location from OpenStreetMap'; }
  } else if (out.geo) out.geoHow = 'venue location from the source';
  out.suit = suitabilityOf(out);
  out.topicList = topicsOf(out);
  return out;
}

function rebuild(all) {
  state.notices = all.filter((e) => e.suit.notice);
  state.events = mergeDuplicates(all.filter((e) => !e.suit.notice));
}

async function load(forceEw = false) {
  const status = [];
  const now = new Date().toISOString();
  const [lib, venues] = await Promise.all([
    loadJson('events.json').then((d) => ({ ok: true, d }), (err) => ({ ok: false, err })),
    loadJson('venues.json').then((d) => d.venues || {}, () => ({})),
  ]);
  state.venues = venues;
  venueList = Object.entries(venues).filter(([, v]) => v).map(([k, v]) => [...k.split('|'), v]);

  let libEvents = [];
  if (lib.ok) {
    libEvents = (lib.d.events || []).map((e) => prepare(e, e.firstSeen || now));
    for (const s of lib.d.sources || []) {
      status.push({
        name: s.name, ok: s.ok, count: s.count, at: s.ok ? s.checkedAt : s.lastGoodAt,
        detail: s.ok ? `${s.count} events, checked on GitHub ${fmtClock(s.checkedAt)}` : `couldn't refresh (${s.error}); showing data from ${fmtClock(s.lastGoodAt).replace(/^at /, '')}`,
      });
    }
    const hrs = (Date.now() - new Date(lib.d.generatedAt).getTime()) / 3600000;
    if (hrs > 3) status.push({ name: 'GitHub job', ok: false, at: lib.d.generatedAt, detail: `last ran ${ago(lib.d.generatedAt)}; the hourly update may be paused` });
  } else {
    status.push({ name: 'Library events', ok: false, detail: `couldn't load the events file (${lib.err.message})` });
  }
  state.status = [...status, { name: SOURCE_NAMES['explore-waterloo'], ok: true, detail: 'loading' }];
  rebuild(libEvents);
  render();

  // Explore Waterloo: events appear page by page while the feed loads.
  const seen = store.get('seen', {});
  const firstSeenOf = (e) => seen[e.id] || now;
  let streamed = [];
  let pending = null;
  const ew = await loadEw(forceEw, (fresh) => {
    streamed = streamed.concat(fresh.map((e) => prepare(e, firstSeenOf(e))));
    if (!pending) pending = setTimeout(() => { pending = null; rebuild([...libEvents, ...streamed]); render(); }, 250);
  });
  clearTimeout(pending);

  const nextSeen = {};
  const ewPrepared = ew.events.map((e) => { nextSeen[e.id] = firstSeenOf(e); return prepare(e, nextSeen[e.id]); });
  if (ew.ok) store.set('seen', nextSeen); // also drops ids that are gone
  status.push({
    name: SOURCE_NAMES['explore-waterloo'], ok: ew.ok, count: ew.events.length, at: ew.fetchedAt,
    detail: ew.ok ? `${ew.events.length} events, read on this phone ${fmtClock(ew.fetchedAt)}`
      : (ew.fetchedAt ? `couldn't refresh (${ew.error}); showing your copy from ${fmtClock(ew.fetchedAt).replace(/^at /, '')}` : `couldn't load (${ew.error})`),
  });
  state.status = status;
  rebuild([...libEvents, ...ewPrepared]);
  store.set('visit', now); // state.prevVisit keeps the earlier visit for this session's "New" badges
  render();
  lookupNewVenues();
}

// A few new venues per visit, only when distances are wanted; one request per 1.2 s; cached.
async function lookupNewVenues() {
  if (!state.loc) return;
  const missing = [...new Set(state.events.filter((e) => e.venueKey && !e.geo && !(e.venueKey in state.venues) && !(e.venueKey in state.geoCache)).map((e) => e.venueKey))];
  // (events whose venue is in venues.json as "no match" are skipped: already tried)
  let done = 0;
  for (const key of missing.slice(0, PHONE_LOOKUPS_PER_VISIT)) {
    const ev = state.events.find((e) => e.venueKey === key);
    const parts = (ev.location || '').split(',').map((s) => s.trim());
    const q = parts.slice(0, 3).join(', ');
    await new Promise((r) => { setTimeout(r, 1200); });
    try {
      const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: `${q}, Ontario`, format: 'jsonv2', limit: '1', countrycodes: 'ca' })}`;
      const r = await (await fetch(url)).json();
      const hit = r[0] && +r[0].lat > 43.2 && +r[0].lat < 43.75 && +r[0].lon > -80.95 && +r[0].lon < -80.15 ? r[0] : null;
      state.geoCache[key] = hit ? { lat: +(+hit.lat).toFixed(5), lng: +(+hit.lon).toFixed(5) } : null;
      done++;
    } catch { break; }
  }
  if (done) {
    store.set('geo', state.geoCache);
    state.events = state.events.map((e) => (e.venueKey && !e.geo && state.geoCache[e.venueKey] ? { ...e, geo: state.geoCache[e.venueKey], geoHow: 'venue location from OpenStreetMap' } : e));
    render();
  }
}

// ---------- Filtering ----------
function dateRange() {
  const today = isoOf(new Date());
  if (state.dates === 'today') return [today, today];
  if (state.dates === 'weekend') {
    const wd = new Date().getDay();
    if (wd === 6) return [today, addDays(today, 1)];
    if (wd === 0) return [today, today];
    const sat = addDays(today, 6 - wd);
    return [sat, addDays(sat, 1)];
  }
  if (state.dates === 'custom') {
    const f = state.from || today; const t = state.to || addDays(f, 6);
    return f <= t ? [f, t] : [t, f];
  }
  return [today, addDays(today, 13)];
}

// Kids mode: 1 = source says it suits these ages, 2 = for families or all ages,
// 3 = no age listed, 0 = source says it's for other ages (hidden).
function kidTier(e) {
  const a = e.derived?.age;
  const { min, max } = state.kid;
  if (!a) return { tier: 3, why: 'The source doesn\'t list an age.' };
  if (a.kind === 'range') return a.min <= max && a.max >= min ? { tier: 1, why: `Fits ages ${min} to ${max}: the source says “${a.text}”.` } : { tier: 0 };
  if (a.kind === 'minimum') return a.min <= max ? { tier: 1, why: `Fits ages ${min} to ${max}: the source says “${a.text}”.` } : { tier: 0 };
  if (['all-ages', 'families', 'everyone'].includes(a.kind)) return { tier: 2, why: `The source says “${a.text}”.` };
  return { tier: 0 };
}

// Family mode: nothing extra is hidden, but these are pushed below the rest.
function familyPushReasons(e) {
  const r = e.suit.notes.filter((n) => ['drinks', 'late', 'nightlife'].includes(n.key)).map((n) => n.label);
  const a = e.derived?.age;
  if (a && (a.kind === 'adults' || a.kind === 'older-adults' || (a.kind === 'minimum' && a.min >= 13) || (a.kind === 'range' && a.min >= 13))) r.unshift(`Source says “${a.text}”`);
  return r;
}

function filtered() {
  const [from, to] = dateRange();
  const hidden = { adults: 0, otherAges: 0, far: 0, noLocation: 0, earlier: 0 };
  const out = [];
  const today = isoOf(new Date());
  const nowT = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  // Over already today: the stated end time has passed, or with no end listed, it started 3+ hours ago.
  const over = (e) => {
    if (e.start.date !== today || !e.derived?.timeListed) return false;
    if (e.end && e.end.date !== today) return false;
    if (e.end?.time) return e.end.time < nowT;
    const [hh, mm] = e.start.time.split(':').map(Number);
    return `${pad(Math.min(23, hh + 3))}:${pad(mm)}` < nowT;
  };
  for (const e of state.events) {
    const endDate = e.end?.date || e.start.date;
    if (e.start.date > to || endDate < from) continue;
    if (over(e)) { hidden.earlier++; continue; }
    if (e.derived?.region?.status === 'out') continue;
    if (state.who !== 'everyone' && e.suit.adultsOnly) { hidden.adults++; continue; }
    let tier = null;
    if (state.who === 'kids') { tier = kidTier(e); if (tier.tier === 0) { hidden.otherAges++; continue; } }
    if (state.topics.size && !e.topicList.some((t) => state.topics.has(t.id))) continue;
    if (state.q && !searchMatch(e, state.q)) continue;
    if (state.cost !== 'any' && e.suit.cost.kind !== state.cost) continue;
    if (state.setting !== 'any' && e.suit.setting?.kind !== state.setting) continue;
    const reg = e.registration?.state;
    if (state.reg === 'dropin' && reg !== 'drop-in') continue;
    if (state.reg === 'open' && reg !== 'open') continue;
    if (state.hideFull && (reg === 'full' || reg === 'closed')) continue;
    let dist = null;
    if (state.loc && e.geo) dist = km(state.loc, e.geo);
    if (state.radius) {
      if (dist === null) { hidden.noLocation++; continue; }
      if (dist > Number(state.radius)) { hidden.far++; continue; }
    }
    const push = state.who === 'everyone' ? [] : familyPushReasons(e);
    out.push({ e, tier, push, dist, day: e.start.date < from ? from : e.start.date });
  }
  const rank = (x) => (x.tier ? x.tier.tier : 0) * 10 + (x.push.length ? 1 : 0);
  out.sort((a, b) => a.day.localeCompare(b.day) || rank(a) - rank(b) || (a.e.start.time || '99').localeCompare(b.e.start.time || '99'));
  return { list: out, hidden, from, to };
}

// ---------- Rendering ----------
function regTag(e) {
  const r = e.registration;
  if (!r) return e.source === 'wpl' ? h('span', { class: 'tag soft', text: 'Registration not checked yet' }) : null;
  switch (r.state) {
    case 'open': return h('span', { class: 'tag open', text: r.seatsRemaining ? `${r.seatsRemaining} spot${r.seatsRemaining === 1 ? '' : 's'} left` : 'Spots open' });
    case 'full': return h('span', { class: 'tag full', text: r.waitlist ? 'Full, wait list open' : 'Full' });
    case 'closed': return h('span', { class: 'tag full', text: 'Registration closed' });
    case 'drop-in': return h('span', { class: 'tag', text: 'Drop-in' });
    case 'not-open-yet': return h('span', { class: 'tag soft', text: 'Registration not open yet' });
    default: return null;
  }
}

function ageLine(e) {
  const a = e.derived?.age;
  if (!a) return 'Age not listed';
  let t = cap(a.text);
  if (a.how === 'converted' && a.kind === 'range' && !/age|month|birth|20s/i.test(a.text)) t += ` (about ages ${a.min} to ${a.max})`;
  if (a.caregiver) t += ', with a caregiver';
  return t;
}

function card(x, { inSaved = false } = {}) {
  const { e } = x;
  const open = state.expanded.has(e.id);
  const isNew = state.prevVisit && e.firstSeen && e.firstSeen > state.prevVisit;
  const place = e.derived?.region?.place;
  const venue = e.venue || (e.location ? e.location.split(/,|\s+-(?:\s+|$)/)[0].trim() : null);
  const where = [venue, place && !(venue || '').includes(place) ? place : null].filter(Boolean).join(', ') || 'Location not listed';
  const distText = x.dist !== null && x.dist !== undefined ? `, ${x.dist < 10 ? x.dist.toFixed(1) : Math.round(x.dist)} km away` : (state.loc ? ', distance unknown' : '');
  const tags = [
    isNew ? h('span', { class: 'tag new', text: 'New' }) : null,
    e.suit.cancelled ? h('span', { class: 'tag full', text: 'Cancelled' }) : null,
    regTag(e),
    e.suit.cost.kind === 'free' ? h('span', { class: 'tag', text: 'Free' }) : null,
    e.suit.cost.kind === 'paid' ? h('span', { class: 'tag soft', text: e.suit.cost.text }) : null,
    e.suit.setting?.kind === 'outdoor' ? h('span', { class: 'tag soft', text: 'Outdoor' }) : null,
    ...(x.push || []).map((p) => h('span', { class: 'tag soft', text: p })),
    state.who === 'everyone' && e.suit.adultsOnly ? h('span', { class: 'tag soft', text: 'Adults only' }) : null,
  ].filter(Boolean);
  const bodyId = `b-${e.id.replace(/[^\w-]/g, '_')}`;
  const head = h('button', {
    type: 'button', class: 'card-head', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId,
    onclick: () => { if (open) state.expanded.delete(e.id); else state.expanded.add(e.id); render(); },
  },
  h('div', { class: 'when', text: inSaved ? `${dayLabel(e.start.date)}, ${fmtWhen(e)}` : fmtWhen(e) }),
  h('h3', { text: e.title }),
  h('div', { class: 'where', text: where + distText }),
  h('div', { class: `age${x.tier && x.tier.tier === 1 ? ' fit' : ''}`, text: ageLine(e) }),
  tags.length ? h('div', { class: 'tags' }, tags) : null,
  h('div', { class: 'source', text: `From ${SOURCE_NAMES[e.source] || e.source}, checked ${fmtClock(e.lastChecked)}` }));
  const el = h('article', { class: 'card' }, head);
  if (open) el.append(cardBody(x, bodyId));
  return el;
}

function cardBody(x, id) {
  const { e } = x;
  const s = e.suit;
  const facts = [];
  if (s.adultsOnly) facts.push(h('li', {}, `Adults only: ${s.adultsOnly.why}. `, h('span', { class: 'how', text: s.adultsOnly.how === 'stated' ? '(stated by the source)' : '(worked out from the venue)' })));
  for (const n of s.notes) facts.push(h('li', {}, `${n.label}${n.from && n.key !== 'late' ? `: “${n.from}”` : ''}. `, h('span', { class: 'how', text: n.how === 'stated' ? '(stated by the source)' : '(worked out from the venue name)' })));
  if (s.cost.kind !== 'not-listed') facts.push(h('li', { text: `Cost: ${s.cost.text}` }));
  else facts.push(h('li', { text: 'Cost not listed by the source.' }));
  if (s.setting) facts.push(h('li', {}, `${cap(s.setting.kind)}. `, h('span', { class: 'how', text: s.setting.how === 'stated' ? '(stated by the source)' : '(worked out from the room name)' })));
  if (e.registration) facts.push(h('li', { text: `Registration status read from the event page ${fmtClock(e.registration.checkedAt)}.` }));
  if (x.dist !== null && x.dist !== undefined) facts.push(h('li', { text: `Distance is a straight line from ${state.loc.label} to the ${e.geoHow}.` }));

  const why = state.who === 'kids' && x.tier ? x.tier.why : (e.derived?.age ? `The source says “${e.derived.age.text}”.` : 'The source doesn\'t list an age.');
  const saved = Boolean(state.saved[e.id]);
  return h('div', { class: 'card-body', id },
    e.description ? h('div', {}, h('h4', { text: 'About' }), h('p', { class: 'desc', text: e.description + (e.descriptionTruncated ? '\n\nShortened here; the full text is on the source page.' : '') })) : null,
    h('h4', { text: state.who === 'kids' ? 'Why it fits' : 'Who it\'s for' }), h('p', { text: why }),
    e.location ? h('div', {}, h('h4', { text: 'Where' }), h('p', { text: e.location })) : null,
    h('h4', { text: 'Good to know' }), h('ul', {}, facts),
    e.alsoListed ? h('div', {}, h('h4', { text: 'Also listed' }), h('ul', {}, e.alsoListed.map((a) => h('li', {}, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: `${SOURCE_NAMES[a.source] || a.source}: ${a.title}` }) : a.title)))) : null,
    e.derived?.notes?.length ? h('div', {}, h('h4', { text: 'About this listing' }), h('ul', {}, e.derived.notes.map((n) => h('li', { class: 'how', text: n })))) : null,
    h('div', { class: 'card-actions' },
      e.url ? h('a', { class: 'btn primary', href: e.url, target: '_blank', rel: 'noopener noreferrer', text: `Open on ${SOURCE_NAMES[e.source] || 'source'}` }) : h('p', { class: 'how', text: 'The source gave no link for this event.' }),
      h('div', { class: 'pair' },
        h('button', { type: 'button', class: 'btn', text: saved ? 'Saved' : 'Save', 'aria-pressed': saved ? 'true' : 'false', onclick: () => toggleSave(e) }),
        h('button', { type: 'button', class: 'btn', text: 'Add to calendar', onclick: () => downloadIcs(e) }))));
}

function render() {
  renderStatus();
  renderControls();
  if (state.view === 'events') renderEvents();
  else if (state.view === 'programs') renderPrograms();
  else if (state.view === 'providers') renderProviders();
  else renderSaved();
  renderElsewhere();
  $('saved-count').textContent = Object.keys(state.saved).length ? `(${Object.keys(state.saved).length})` : '';
}

function renderStatus() {
  if (!state.status.length) return;
  const bad = state.status.filter((s) => !s.ok).length;
  // The newest update is what "Updated" means to a reader; each source's own time is in the list below,
  // and a source that's really stale still shows as a problem there.
  const newest = state.status.filter((s) => s.ok && s.at).map((s) => s.at).sort().slice(-1)[0];
  $('status-summary').textContent = `${newest ? `Updated ${ago(newest)}` : 'Not updated'}${bad ? `, ${bad} problem${bad === 1 ? '' : 's'}` : ''}`;
  $('status-summary').classList.toggle('bad', bad > 0);
  $('status-list').replaceChildren(...state.status.map((s) => h('li', { class: s.ok ? null : 'bad', text: `${s.name}: ${s.detail}` })));
}

function renderControls() {
  for (const b of $('seg-dates').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.dates));
  for (const b of $('seg-who').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.who));
  $('kids-btn').textContent = state.kid.min === state.kid.max ? `Kids ${state.kid.min}` : `Kids ${state.kid.min} to ${state.kid.max}`;
  $('custom-dates').hidden = state.dates !== 'custom';
  for (const c of $('topics').children) c.setAttribute('aria-pressed', String(state.topics.has(c.dataset.id)));
  const n = (state.cost !== 'any') + (state.setting !== 'any') + (state.reg !== 'any') + state.hideFull + Boolean(state.radius);
  $('filters-open').textContent = n ? `More filters (${n} on)` : 'More filters';
  for (const g of document.querySelectorAll('[data-filter]')) for (const b of g.children) b.setAttribute('aria-pressed', String(b.dataset.v === state[g.dataset.filter]));
  $('hide-full').checked = state.hideFull;
  $('radius').value = state.radius;
  $('loc-label').textContent = state.loc ? `Distances from ${state.loc.label} (rounded to about 1 km, kept on this phone).` : 'No location set. Distances need one.';
  $('clear-loc').hidden = !state.loc;
}

function renderEvents() {
  const { list, hidden, from, to } = filtered();
  const span = state.dates === 'today' ? 'today' : state.dates === 'weekend' ? 'this weekend' : state.dates === '2w' ? 'in the next 2 weeks' : `from ${dateOf(from).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} to ${dateOf(to).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
  const parts = [`${list.length} event${list.length === 1 ? '' : 's'} ${span}`];
  if (state.who === 'kids') {
    const c = [1, 2, 3].map((t) => list.filter((x) => x.tier.tier === t).length);
    parts.push(`${c[0]} that fit, ${c[1]} for families or all ages, ${c[2]} with no age listed`);
  }
  const hid = [];
  if (hidden.adults) hid.push(`${hidden.adults} adults-only`);
  if (hidden.otherAges) hid.push(`${hidden.otherAges} for other ages`);
  if (hidden.far) hid.push(`${hidden.far} farther away`);
  if (hidden.noLocation) hid.push(`${hidden.noLocation} with no known location`);
  if (hidden.earlier) hid.push(`${hidden.earlier} earlier today`);
  $('summary').textContent = `${parts.join(': ')}.${hid.length ? ` Hidden: ${hid.join(', ')}.` : ''}`;

  const root = $('results');
  if (!state.events.length && !state.status.length) { root.replaceChildren(); return; }
  if (!list.length) {
    root.replaceChildren(h('div', { class: 'empty' },
      h('p', { text: 'No events match. Try more dates, fewer filters, or a different search.' }),
      h('button', { type: 'button', class: 'btn primary', text: 'Clear search and filters', onclick: clearAll })));
    return;
  }
  const days = new Map();
  for (const x of list) { if (!days.has(x.day)) days.set(x.day, []); days.get(x.day).push(x); }
  root.replaceChildren(...[...days].map(([day, xs]) => {
    const notices = state.notices.filter((n) => n.start.date === day);
    const TIER_NAMES = { 2: 'For families or all ages', 3: 'No age listed' };
    const items = [];
    let lastTier = null;
    for (const x of xs) {
      const t = x.tier?.tier;
      if (state.who === 'kids' && t !== lastTier && TIER_NAMES[t]) items.push(h('h3', { class: 'tier', text: TIER_NAMES[t] }));
      lastTier = t;
      items.push(card(x));
    }
    return h('section', { class: 'day' },
      h('h2', { text: dayLabel(day) }),
      notices.map((n) => h('p', { class: 'notice', text: `${SOURCE_NAMES[n.source]}: ${n.title}` })),
      items);
  }));
}

// The current copy of a saved program (sessions are saved by registration code; older saves by title).
function liveProgram(s) {
  const byId = state.programs.filter((p) => p.id === s.event.id);
  if (byId.length) return byId;
  return state.programs.filter((p) => `${p.source}|${p.title}` === s.event.id);
}
function savedItems() {
  return Object.entries(state.saved).map(([id, s]) => {
    if (s.kind === 'custom') return { id, s, kind: 'custom', c: s.custom, live: true };
    if (s.kind === 'program') { const live = liveProgram(s); return { id, s, kind: 'program', sessions: live.length ? live : s.sessions, live: live.length > 0 }; }
    const live = state.events.find((e) => e.id === s.event.id);
    return { id, s, kind: 'event', e: live || s.event, live: Boolean(live) };
  });
}
function savedCard(item) {
  if (item.kind === 'custom') return customCard(item);
  const today = isoOf(new Date());
  if (item.kind === 'program') return programCard({ id: item.id, first: item.sessions[0], sessions: item.sessions });
  const e = item.e;
  const el = card({ e, tier: state.who === 'kids' ? kidTier(e) : null, push: [], dist: state.loc && e.geo ? km(state.loc, e.geo) : null }, { inSaved: true });
  if (!item.live) el.querySelector('.source').textContent = (e.end?.date || e.start.date) < today ? 'This event has passed.' : 'No longer in the source listings. It may have been removed or changed; check the source.';
  return el;
}

function renderSaved() {
  const firstDate = (x) => (x.kind === 'event' ? x.e.start.date : x.kind === 'custom' ? (x.c.repeat === 'once' ? x.c.date : x.c.first) : x.sessions[0].start?.date) || '9999';
  const entries = savedItems().sort((a, b) => firstDate(a).localeCompare(firstDate(b)));
  for (const b of $('seg-calview').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.calView));
  $('cal-list').hidden = state.calView !== 'list';
  $('cal-body').hidden = state.calView === 'list';
  if (state.calView === 'list') {
    $('saved-list').replaceChildren(...(entries.length ? entries.map(savedCard) : [h('div', { class: 'empty' }, h('p', { text: 'Nothing saved yet. Open an event or program and tap Save.' }))]));
    return;
  }
  renderCalendar(entries);
}

// Calendar: the days each saved item happens on, as a month grid or a week strip, with
// the selected day's items listed below. Only saved items appear.
function renderCalendar(entries) {
  const today = isoOf(new Date());
  const byDay = new Map();
  const unplaced = [];
  for (const item of entries) {
    const occ = occurrences(item.kind === 'event' ? { kind: 'event', e: item.e } : item.kind === 'custom' ? { kind: 'custom', c: item.c } : { kind: 'program', sessions: item.sessions });
    if (!occ.dates.length) { unplaced.push({ item, why: occ.unplaced }); continue; }
    for (const o of occ.dates) {
      if (!byDay.has(o.date)) byDay.set(o.date, []);
      byDay.get(o.date).push({ item, o });
    }
  }
  if (!state.calDay) {
    const next = [...byDay.keys()].filter((d) => d >= today).sort()[0];
    state.calDay = byDay.has(today) || !next ? today : next;
  }
  const sel = state.calDay;
  const body = $('cal-body');
  const isEmpty = !entries.length;
  const monthName = (iso) => dateOf(iso).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const dayLabel = (iso) => dateOf(iso).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
  const countFor = (iso) => (byDay.get(iso) || []).length;
  const kindsFor = (iso) => [...new Set((byDay.get(iso) || []).map((x) => x.item.kind))];
  const pick = (iso) => { state.calDay = iso; state.calOpen = null; render(); };

  const dayButton = (iso, extraClass = '') => {
    const n = countFor(iso);
    const d = dateOf(iso);
    const cls = ['cal-day', extraClass, iso === today ? 'is-today' : '', iso === sel ? 'is-selected' : '', n ? 'has-items' : ''].filter(Boolean).join(' ');
    return h('button', { type: 'button', class: cls, 'aria-pressed': iso === sel ? 'true' : 'false', 'aria-label': `${dayLabel(iso)}${iso === today ? ', today' : ''}: ${n ? `${n} saved` : 'nothing saved'}`, onclick: () => pick(iso) },
      extraClass === 'in-week' ? h('span', { class: 'cal-wd', text: d.toLocaleDateString('en-CA', { weekday: 'short' }) }) : null,
      h('span', { class: 'cal-num', text: String(d.getDate()) }),
      h('span', { class: 'cal-marks', 'aria-hidden': 'true' }, kindsFor(iso).map((k) => h('i', { class: `mark ${k}` })), n > 1 ? h('b', { text: String(n) }) : null));
  };

  let nav, grid;
  if (state.calView === 'month') {
    const days = monthGrid(sel);
    const m = dateOf(sel).getMonth();
    const shiftMonth = (k) => { const d = dateOf(sel); const t = new Date(d.getFullYear(), d.getMonth() + k, 1); pick(isoOf(t)); };
    nav = calNav(monthName(sel), () => shiftMonth(-1), () => shiftMonth(1), 'month');
    grid = h('div', { class: 'cal-month', role: 'group', 'aria-label': monthName(sel) },
      ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => h('span', { class: 'cal-head', 'aria-hidden': 'true', text: w, title: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i] })),
      days.map((iso) => dayButton(iso, dateOf(iso).getMonth() === m ? '' : 'other-month')));
    swipe(grid, () => shiftMonth(1), () => shiftMonth(-1));
  } else {
    const days = weekOf(sel);
    const label = `${dateOf(days[0]).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} to ${dateOf(days[6]).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
    nav = calNav(label, () => pick(calAddDays(sel, -7)), () => pick(calAddDays(sel, 7)), 'week');
    grid = h('div', { class: 'cal-week', role: 'group', 'aria-label': `Week of ${label}` }, days.map((iso) => dayButton(iso, 'in-week')));
    swipe(grid, () => pick(calAddDays(sel, 7)), () => pick(calAddDays(sel, -7)));
  }

  const list = (byDay.get(sel) || []).sort((a, b) => String(a.o.time || a.o.timeText || 'zz').localeCompare(String(b.o.time || b.o.timeText || 'zz')));
  const agenda = h('section', { class: 'cal-agenda', 'aria-live': 'polite' },
    h('h3', { text: `${dayLabel(sel)}${sel === today ? ' (today)' : ''}` }),
    list.length ? list.map(({ item, o }) => agendaRow(item, o, sel))
      : isEmpty ? h('div', { class: 'empty' },
        h('p', { text: 'Your calendar is empty. Save an event or a program and it shows up here on every day it happens, or use Add your own.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Browse events', onclick: () => document.querySelector('.tabs button[data-view="events"]').click() }))
        : h('p', { class: 'muted', text: 'Nothing saved for this day.' }));

  body.replaceChildren(...[nav, grid,
    h('p', { class: 'cal-legend' }, h('i', { class: 'mark event', 'aria-hidden': 'true' }), ' Event ', h('i', { class: 'mark program', 'aria-hidden': 'true' }), ' Program ', h('i', { class: 'mark custom', 'aria-hidden': 'true' }), ' Yours'),
    agenda,
    unplaced.length ? h('section', { class: 'cal-unplaced' }, h('h3', { text: 'Saved but not on the calendar' }),
      unplaced.map(({ item, why }) => h('div', { class: 'cal-row-wrap' }, h('p', { text: `${item.kind === 'event' ? item.e.title : item.kind === 'custom' ? item.c.title : item.sessions[0].title}. ${why}` })))) : null].filter(Boolean));
}

function calNav(label, prev, next, unit) {
  const today = isoOf(new Date());
  return h('div', { class: 'cal-nav' },
    h('button', { type: 'button', class: 'btn icon', 'aria-label': `Previous ${unit}`, onclick: prev, text: '‹' }),
    h('h3', { class: 'cal-title', text: label }),
    h('button', { type: 'button', class: 'btn icon', 'aria-label': `Next ${unit}`, onclick: next, text: '›' }),
    h('button', { type: 'button', class: 'btn cal-today', text: 'Today', onclick: () => { state.calDay = today; state.calOpen = null; render(); } }));
}

function agendaRow(item, o, day) {
  const key = `${item.id}|${day}`;
  const open = state.calOpen === key;
  const title = item.kind === 'event' ? item.e.title : item.kind === 'custom' ? item.c.title : (o.session || item.sessions[0]).title;
  const place = item.kind === 'event' ? (item.e.location || '').split(',')[0] : item.kind === 'custom' ? item.c.place || '' : (o.session || item.sessions[0]).facility || (o.session || item.sessions[0]).location || '';
  const time = item.kind === 'custom' ? (o.time ? timeRange(o.time, o.endTime) : 'Time not set') : o.time ? timeRange(o.time, item.kind === 'program' && o.session?.end?.time ? o.session.end.time : (item.kind === 'event' && item.e.derived?.timeListed ? item.e.end?.time : null)) : o.timeText || (item.kind === 'event' && o.multiDay ? 'All day or ongoing' : 'Time not listed');
  return h('div', { class: 'cal-row-wrap' },
    h('button', { type: 'button', class: 'cal-row', 'aria-expanded': open ? 'true' : 'false', onclick: () => { state.calOpen = open ? null : key; render(); } },
      h('i', { class: `mark ${item.kind}`, 'aria-hidden': 'true' }),
      h('span', { class: 'cal-time', text: time }),
      h('span', { class: 'cal-what' }, h('strong', { text: title }), place ? h('span', { text: place }) : null)),
    open ? savedCard(item) : null);
}

// ---------- Your own entries ----------
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
function datesSummary(dates) {
  const wds = [...new Set(dates.map((d) => dateOf(d).getDay()))].sort();
  const first = dateOf(dates[0]).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  const last = dateOf(dates[dates.length - 1]).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  return dates.length === 1 ? dateOf(dates[0]).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : `${dates.length} dates, ${wds.length <= 3 ? wds.map((d) => WD_PLURAL[d]).join(', ') : 'various days'}, ${first} to ${last}`;
}
function customSummary(c) {
  if (c.repeat === 'dates') return `${datesSummary(c.dates)}${c.start ? `, ${timeRange(c.start, c.end || null)}` : ''}`;
  const when = c.repeat === 'once'
    ? dateOf(c.date).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : `${c.weekdays.slice().sort().map((d) => WD_PLURAL[d]).join(', ')}, ${dateOf(c.first).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} to ${dateOf(c.last).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return `${when}${c.start ? `, ${timeRange(c.start, c.end || null)}` : ''}`;
}
function customCard(item) {
  const c = item.c;
  let safeUrl = null;
  try { const u = new URL(c.url); if (u.protocol === 'https:' || u.protocol === 'http:') safeUrl = u.href; } catch { /* no link */ }
  return h('article', { class: 'custom-card' },
    h('h3', { text: c.title }),
    h('p', { text: customSummary(c) }),
    c.place ? h('p', { text: c.place }) : null,
    c.notes ? h('p', { class: 'muted', text: c.notes }) : null,
    h('p', { class: 'how', text: 'Added by you. Grand Calendar doesn\'t check or update it.' }),
    safeUrl ? h('a', { class: 'btn', href: safeUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open link' }) : null,
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => openAddOwn(item.id) }),
      h('button', { type: 'button', class: 'btn', text: 'Delete', onclick: () => deleteCustom(item.id) })));
}

let aoEditing = null;
let aoRepeat = 'once';
let aoDates = null;
let aoDays = new Set();
function setRepeat(v) {
  aoRepeat = v;
  for (const b of $('ao-repeat').children) b.setAttribute('aria-pressed', String(b.dataset.v === v));
  $('ao-once').hidden = v !== 'once';
  $('ao-weekly').hidden = v !== 'weekly';
}
function drawDays() {
  $('ao-days').replaceChildren(...WD_SHORT.map((label, i) => h('button', {
    type: 'button', 'aria-pressed': aoDays.has(i) ? 'true' : 'false', 'aria-label': WD_PLURAL[i], text: label.slice(0, 2),
    onclick: () => { if (aoDays.has(i)) aoDays.delete(i); else aoDays.add(i); drawDays(); },
  })));
}
function openAddOwn(editId = null) {
  aoEditing = editId;
  const c = editId ? state.saved[editId].custom : null;
  $('add-own-h').textContent = c ? 'Edit your entry' : 'Add your own';
  $('ao-title').value = c?.title || '';
  $('ao-place').value = c?.place || '';
  $('ao-date').value = c?.date || state.calDay || isoOf(new Date());
  $('ao-first').value = c?.first || state.calDay || isoOf(new Date());
  $('ao-last').value = c?.last || '';
  $('ao-start').value = c?.start || '';
  $('ao-end').value = c?.end || '';
  $('ao-url').value = c?.url || '';
  $('ao-notes').value = c?.notes || '';
  aoDays = new Set(c?.weekdays || []);
  aoDates = c?.repeat === 'dates' ? c.dates : null;
  const fromFile = Boolean(aoDates);
  $('ao-import').hidden = Boolean(editId);
  document.querySelector('#add-own .or-line').hidden = Boolean(editId);
  $('ao-repeat').hidden = fromFile;
  $('ao-dates-note').hidden = !fromFile;
  if (fromFile) { $('ao-dates-note').textContent = `Dates come from the imported calendar file: ${datesSummary(aoDates)}.`; $('ao-once').hidden = true; $('ao-weekly').hidden = true; aoRepeat = 'dates'; }
  else setRepeat(c?.repeat || 'once');
  drawDays();
  $('ao-ics-status').textContent = '';
  $('ao-error').hidden = true;
  $('add-own').showModal();
}
function saveAddOwn(ev) {
  ev.preventDefault();
  const c = {
    title: $('ao-title').value.trim(), place: $('ao-place').value.trim(), repeat: aoRepeat,
    dates: aoRepeat === 'dates' ? aoDates : undefined,
    date: aoRepeat === 'once' ? $('ao-date').value : null,
    weekdays: aoRepeat === 'weekly' ? [...aoDays].sort() : [],
    first: aoRepeat === 'weekly' ? $('ao-first').value : null,
    last: aoRepeat === 'weekly' ? $('ao-last').value : null,
    start: $('ao-start').value || null, end: $('ao-end').value || null,
    url: $('ao-url').value.trim() || null, notes: $('ao-notes').value.trim() || null,
  };
  const problem = validateCustom(c);
  if (problem) { $('ao-error').textContent = problem; $('ao-error').hidden = false; return; }
  const id = aoEditing || `custom:${Date.now().toString(36)}`;
  if (c.dates === undefined) delete c.dates;
  const firstDay = c.repeat === 'once' ? c.date : occurrences({ kind: 'custom', c }).dates[0].date;
  state.saved[id] = { kind: 'custom', custom: c, savedAt: state.saved[id]?.savedAt || new Date().toISOString(), event: { id, title: c.title, start: { date: firstDay } } };
  store.set('saved', state.saved);
  $('add-own').close();
  state.calDay = firstDay; state.calOpen = null;
  render();
  toast(aoEditing ? 'Changes saved.' : 'Saved to your calendar.');
}
// ---------- Importing a calendar file (ActiveNet receipts and others) ----------
let icsFound = [];
function showImport(text, from) {
  const { items, skipped } = readCalendarFile(text);
  if (!items.length) {
    $('ao-ics-status').textContent = skipped.length ? `Nothing could be added: ${skipped.map((x) => `${x.title}: ${x.why}`).join(' ')}` : 'The file had no events in it.';
    return;
  }
  const existing = Object.values(state.saved).filter((v) => v.kind === 'custom').map((v) => `${v.custom.title}|${(v.custom.dates || []).join(',')}`);
  icsFound = items.map((it) => ({ ...it, dupe: existing.includes(`${it.title}|${it.dates.join(',')}`) }));
  $('ics-items').replaceChildren(...icsFound.map((it, i) => h('label', { class: `ics-item${it.dupe ? ' dupe' : ''}` },
    h('input', { type: 'checkbox', 'data-i': String(i), checked: !it.dupe }),
    h('div', {},
      h('strong', { text: it.title }),
      h('span', { text: `${datesSummary(it.dates)}${it.start ? `, ${timeRange(it.start, it.end || null)}` : ''}` }),
      it.place ? h('span', { text: it.place }) : null,
      it.dupe ? h('span', { text: 'Already in your calendar.' }) : null))));
  $('ics-skipped').replaceChildren(...(skipped.length ? [h('p', { text: `Not added: ${skipped.map((x) => `${x.title}: ${x.why}`).join(' ')}` })] : []));
  icsFound.from = from;
  $('add-own').close();
  $('ics-preview').showModal();
}
async function icsFromLink() {
  const link = $('ao-ics-url').value.trim();
  const helper = store.get('searchUrl', '').replace(/\/+$/, '');
  const st = $('ao-ics-status');
  if (!link) { st.textContent = 'Paste the calendar link from the receipt first.'; return; }
  if (!helper) { st.textContent = 'Pasting a link needs the search helper (Settings, Live search). You can choose a saved calendar file instead.'; return; }
  st.textContent = 'Getting the calendar...';
  try {
    const res = await fetch(`${helper}/ics?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    showImport(await res.text(), 'link');
  } catch (err) {
    st.textContent = /load failed|failed to fetch/i.test(err.message) ? 'Couldn\'t reach your helper. Update it with the new worker.js (version 3), then try again.' : `Couldn't get it: ${err.message}`;
  }
}
function addImported(ev) {
  ev.preventDefault();
  const picked = [...$('ics-items').querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => icsFound[Number(x.dataset.i)]);
  if (!picked.length) { $('ics-preview').close(); return; }
  let firstDay = null;
  const ids = [];
  for (const it of picked) {
    const c = { title: it.title, place: it.place || '', repeat: 'dates', dates: it.dates, weekdays: [], start: it.start || null, end: it.end || null, url: it.url || null, notes: 'Imported from a calendar file.' };
    if (validateCustom(c)) continue;
    const id = `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    state.saved[id] = { kind: 'custom', custom: c, savedAt: new Date().toISOString(), event: { id, title: c.title, start: { date: c.dates[0] } } };
    ids.push(id);
    if (!firstDay || c.dates[0] < firstDay) firstDay = c.dates[0];
  }
  store.set('saved', state.saved);
  $('ics-preview').close();
  if (firstDay) { state.calDay = firstDay; state.calOpen = null; }
  render();
  toast(`Added ${ids.length} to your calendar.`, { label: 'Undo', run: () => { for (const id of ids) delete state.saved[id]; store.set('saved', state.saved); render(); } });
}

function deleteCustom(id) {
  const was = state.saved[id];
  delete state.saved[id];
  store.set('saved', state.saved);
  state.calOpen = null;
  render();
  toast('Deleted.', { label: 'Undo', run: () => { state.saved[id] = was; store.set('saved', state.saved); render(); } });
}

// Swipe left or right on the grid to change month or week.
function swipe(el, onLeft, onRight) {
  let x0 = null; let y0 = null; let dir = null;
  el.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) { x0 = null; return; } // leave pinch-zoom alone
    x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dir = null;
  }, { passive: true });
  el.addEventListener('touchmove', (ev) => {
    if (x0 === null) return;
    const dx = ev.touches[0].clientX - x0; const dy = ev.touches[0].clientY - y0;
    if (!dir && Math.hypot(dx, dy) > 8) dir = Math.abs(dx) > Math.abs(dy) ? 'side' : 'down';
    if (dir === 'side') ev.preventDefault(); // lock the page while swiping sideways
  }, { passive: false });
  el.addEventListener('touchend', (ev) => {
    if (x0 === null) return;
    const dx = ev.changedTouches[0].clientX - x0;
    const wasSide = dir === 'side';
    x0 = null; dir = null;
    if (wasSide && Math.abs(dx) > 40) (dx < 0 ? onLeft : onRight)();
  });
  el.addEventListener('touchcancel', () => { x0 = null; dir = null; });
}

function renderElsewhere() {
  const q = state.q.trim() || [...state.topics].map((id) => TOPICS.find((t) => t.id === id)?.label).filter(Boolean)[0] || '';
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const enc = encodeURIComponent(q);
  const links = [
    ['Kitchener Public Library', 'https://kpl.events.mylibrary.digital/', 'events calendar'],
    ['City of Kitchener', 'https://calendar.kitchener.ca/default/Index', 'community calendar'],
    ['City of Waterloo', 'https://events.waterloo.ca/default/Index', 'events calendar'],
    // These sites have phone apps. When the app is installed, iPhone opens it and the app drops
    // the search words, so tapping also copies the search for pasting into the app.
    ['Eventbrite', slug ? `https://www.eventbrite.ca/d/canada--kitchener/${slug}/` : 'https://www.eventbrite.ca/d/canada--kitchener/events/', q ? `searches for “${q}” (also copies it)` : 'Kitchener area', true],
    ['Meetup', q ? `https://www.meetup.com/find/?keywords=${enc}&location=ca--on--Kitchener&source=EVENTS` : 'https://www.meetup.com/find/ca--on--kitchener/', q ? `searches for “${q}” (also copies it)` : 'Kitchener area', true],
    ['Luma', 'https://lu.ma/discover', q ? `opens Luma and copies “${q}” to paste in its search` : 'discover events', true],
    ['Visit Stratford', 'https://visitstratford.ca/calendar/', 'Stratford events calendar'],
  ];
  $('elsewhere-count').textContent = `${links.length} sites`;
  $('elsewhere').replaceChildren(...links.map(([name, href, sub, copies]) => h('a', {
    class: 'btn', href, target: '_blank', rel: 'noopener noreferrer',
    onclick: copies && q ? () => { navigator.clipboard?.writeText(q).then(() => toast(`“${q}” copied. If the ${name} app opens, paste it into its search.`), () => {}); } : null,
  }, h('span', { text: name }), h('small', { text: sub }))));
}

// ---------- Programs ----------
const PROVIDER_TYPES = { gymnastics: 'Gymnastics', swimming: 'Swimming lessons', music: 'Music lessons', dance: 'Dance', coding: 'Coding and robotics', martial: 'Martial arts', art: 'Art classes', skating: 'Skating', sports: 'Kids\' sports clubs' };
async function loadProviders() {
  try { state.providers = (await loadJson('providers.json')).providers || []; } catch { state.providers = []; }
  try { state.providerChecks = (await loadJson('provider-checks.json')).results || {}; } catch { state.providerChecks = {}; }
  if (state.view === 'providers') render();
}
const classFits = (c) => typeof c.min === 'number' && c.min <= state.kid.max && (c.max === null || c.max === undefined || c.max >= state.kid.min);
// Towns a provider can be filtered by; matched against its area and address.
const PROVIDER_TOWNS = ['Kitchener', 'Waterloo', 'Cambridge', 'Elmira', 'St. Jacobs', 'Breslau', 'New Hamburg', 'Baden', 'Wilmot', 'Ayr', 'Wellesley', 'Stratford'];
const savePrefs = () => store.set('prefs', { pwho: state.pwho, provWho: state.provWho, provType: state.provType, provTown: state.provTown, view: state.view });

function providerFlag(p) {
  const ck = state.providerChecks?.[p.id];
  if (!ck || ck.status === 'ok' || ck.status === 'manual') return null;
  const when = ck.flaggedAt ? dateOf(ck.flaggedAt.slice(0, 10)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
  const why = ck.status === 'missing' ? `Some ages listed here are no longer on their page (${ck.missing.join('; ')}).`
    : ck.status === 'changed' ? 'Their page lists different ages than when this was checked, often a new season.'
      : 'Their page couldn\'t be reached at the last monthly check.';
  return `May be out of date: ${why} Flagged ${when}.`;
}

function renderProviders() {
  $('provkids-btn').textContent = $('kids-btn').textContent;
  for (const b of $('seg-provwho').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.provWho));
  const types = [...new Set(state.providers.map((p) => p.type))].sort((a, b) => (PROVIDER_TYPES[a] || a).localeCompare(PROVIDER_TYPES[b] || b));
  $('prov-types').replaceChildren(
    h('button', { type: 'button', class: 'chip', 'aria-pressed': state.provType ? 'false' : 'true', text: 'All', onclick: () => { state.provType = null; savePrefs(); render(); } }),
    ...types.map((t) => h('button', { type: 'button', class: 'chip', 'aria-pressed': state.provType === t ? 'true' : 'false', text: PROVIDER_TYPES[t] || t, onclick: () => { state.provType = state.provType === t ? null : t; savePrefs(); render(); } })));
  // Keep the chosen activity chip in view in its sideways-scrolling row.
  requestAnimationFrame(() => { const c = $('prov-types').querySelector('[aria-pressed="true"]'); const row = $('prov-types'); if (c) row.scrollLeft = c.offsetLeft - row.clientWidth / 2 + c.offsetWidth / 2; });
  const sel = $('prov-town');
  if (sel.options.length === 1) for (const t of PROVIDER_TOWNS) sel.append(h('option', { value: t, text: t }));
  sel.value = state.provTown;
  const q = state.provQ.trim().toLowerCase();
  const kids = state.provWho === 'kids';
  let list = state.providers.filter((p) => !state.provType || p.type === state.provType);
  if (state.provTown) list = list.filter((p) => `${p.area} ${p.address}`.toLowerCase().includes(state.provTown.toLowerCase()));
  if (q) list = list.filter((p) => `${p.name} ${p.sport || ''} ${PROVIDER_TYPES[p.type] || p.type} ${p.area} ${p.classes.map((c) => c.name).join(' ')}`.toLowerCase().includes(q) || q.split(/\s+/).some((w) => w.length > 3 && `${PROVIDER_TYPES[p.type] || ''} ${p.sport || ''}`.toLowerCase().includes(w)));
  if (kids) list = list.filter((p) => p.classes.some(classFits));
  list.sort((a, b) => a.name.localeCompare(b.name));
  const who = kids ? ` with classes for ages ${state.kid.min} to ${state.kid.max}` : '';
  $('prov-summary').textContent = state.providers.length ? `${list.length} provider${list.length === 1 ? '' : 's'}${who}${state.provTown ? ` in ${state.provTown}` : ''}. Tap one for details.` : '';
  if (!state.providers.length) { $('prov-list').replaceChildren(); return; }
  $('prov-list').replaceChildren(...(list.length ? list.map((p) => {
    const open = state.provOpen.has(p.id);
    const fitting = p.classes.filter(classFits);
    const shown = kids ? fitting : p.classes;
    const flag = providerFlag(p);
    // One line of the classes that matter most: the fitting ones in Kids mode, otherwise the first few.
    const label = (c) => (c.stated.toLowerCase().includes(c.name.toLowerCase().split(' (')[0]) ? c.stated : `${c.name} (${c.stated})`);
    const line = shown.slice(0, 2).map(label).join(' · ') + (shown.length > 2 ? ` · +${shown.length - 2} more` : '');
    const row = h('button', { type: 'button', class: 'prov-row', 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (open) state.provOpen.delete(p.id); else state.provOpen.add(p.id); render(); } },
      h('h3', { text: p.name }),
      h('div', { class: 'meta', text: `${p.sport || PROVIDER_TYPES[p.type] || p.type} · ${p.area}` }),
      line ? h('div', { class: 'fits', text: line }) : h('span', { class: 'badge', text: 'Ages not confirmed' }),
      flag ? h('span', { class: 'badge stale-b', text: 'May be out of date' }) : null);
    const card = h('article', { class: `prov-card${open ? ' open' : ''}` }, row);
    if (open) card.append(h('div', { class: 'prov-more' },
      h('div', { class: 'where', text: p.address }),
      p.classes.length ? h('ul', {}, p.classes.map((c) => h('li', { class: !kids && classFits(c) ? 'fit' : '' }, h('span', { text: c.name }), h('span', { class: 'stated', text: `Ages as stated: ${c.stated}` })))) : null,
      !p.classes.length ? h('p', { class: 'how', text: p.agesNote || 'Ages not confirmed.' }) : null,
      p.note ? h('p', { class: 'how', text: p.note }) : null,
      flag ? h('p', { class: 'stale', text: flag }) : null,
      h('p', { class: 'how', text: `Checked ${/^https?:/.test(p.source) ? 'on their website' : `in the ${p.source}`} ${dateOf(p.checked).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}. Classes change each season.` }),
      h('a', { class: 'btn primary', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open their site' })));
    return card;
  }) : [h('div', { class: 'empty' }, h('p', { text: kids ? `No checked providers here list classes for ages ${state.kid.min} to ${state.kid.max}. Try "Everyone" or another town.` : 'No providers match. Try another town or search.' }))]));
}

async function loadPrograms() {
  try {
    const d = await loadJson('programs.json');
    state.programs = d.programs || [];
    state.programsReady = true;
  } catch {
    state.programsReady = 'The programs list isn\'t ready yet. The GitHub job builds it once a day.';
  }
  if (state.view === 'programs') render();
}

const DAY_NAMES = { Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays' };
const shortDate = (iso) => dateOf(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
const timeRange = (a, b) => fmtWhen({ derived: { timeListed: true }, start: { date: 'x', time: a }, end: { date: 'x', time: b } });
const baseTitle = (t) => t.replace(/\s*\((?:\d|[^)]*years|[^)]*\+)[^)]*\)\s*$/, '').trim();

function sessionLine(p) {
  if (p.schedule) return p.schedule.filter((l) => /\d/.test(l)).slice(0, 2).join(', ') || 'Schedule on the township page';
  const single = p.start.date === p.end.date;
  const day = single ? dateOf(p.start.date).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' }) : `${DAY_NAMES[p.days] || p.days}, ${shortDate(p.start.date)} to ${shortDate(p.end.date)}`;
  return `${day}, ${timeRange(p.start.time, p.end.time)}`;
}

function programStatus(p, today) {
  if (!p.start) return { key: 'listed', text: 'Ongoing or dates not given' };
  if (p.end.date < today) return { key: 'ended', text: 'Ended' };
  if (p.start.date > today) return { key: 'upcoming', text: `Starts ${shortDate(p.start.date)}` };
  return { key: 'running', text: `Started ${shortDate(p.start.date)}` };
}

// Kids mode for programs: the guide states an age range or minimum; keep those that include the kid ages.
function programFits(p) {
  const a = p.derived?.age;
  if (!a) return false;
  const { min, max } = state.kid;
  if (a.kind === 'range') return a.min <= max && a.max >= min;
  if (a.kind === 'minimum') return a.min <= max;
  return false;
}
const programIsAdult = (p) => !p.derived?.age || (p.derived.age.kind === 'minimum' && p.derived.age.min >= 13) || (p.derived.age.kind === 'range' && p.derived.age.min >= 13);

function filteredPrograms() {
  const today = isoOf(new Date());
  const groups = new Map();
  let hiddenEnded = 0;
  for (const p of state.programs) {
    if (p.end && p.end.date < today) { hiddenEnded++; continue; }
    if (state.pUpcoming && p.start && p.start.date <= today) continue;
    if (state.pwho === 'kids' && !programFits(p)) continue;
    if (state.pwho === 'adults' && !programIsAdult(p)) continue;
    if (state.pq && !searchMatch({ title: p.title, description: `${p.description} ${p.category || ''} ${p.facility}`, categories: [] }, state.pq)) continue;
    const key = `${p.source}|${p.title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const list = [...groups.values()].map((sessions) => {
    const key = (x) => `${x.start ? x.start.date : '9999'}${x.start?.time || ''}`;
    sessions.sort((a, b) => key(a).localeCompare(key(b)));
    return { id: `${sessions[0].source}|${sessions[0].title}`, first: sessions[0], sessions };
  });
  list.sort((a, b) => {
    const sa = programStatus(a.first, today).key === 'upcoming' ? 0 : 1;
    const sb = programStatus(b.first, today).key === 'upcoming' ? 0 : 1;
    const da = a.first.start ? a.first.start.date : '9999'; const db = b.first.start ? b.first.start.date : '9999';
    return sa - sb || da.localeCompare(db) || a.first.title.localeCompare(b.first.title);
  });
  return { list, hiddenEnded };
}

function programCard(g) {
  const p = g.first;
  const today = isoOf(new Date());
  const open = state.expanded.has(g.id);
  const a = p.derived?.age;
  const ageText = a ? `Ages ${a.text.replace(/ years?/, '').replace(/^(\d+)\+$/, '$1 and up')}` : 'Age not listed';
  const feeText = (f) => (f === '$0.00' ? 'Free ($0.00)' : f);
  const statuses = [...new Set(g.sessions.map((x) => programStatus(x, today).text))];
  const saved = Boolean(state.saved[g.id]);
  const head = h('button', {
    type: 'button', class: 'card-head', 'aria-expanded': open ? 'true' : 'false',
    onclick: () => { if (open) state.expanded.delete(g.id); else state.expanded.add(g.id); render(); },
  },
  h('div', { class: 'when', text: g.sessions.length === 1 ? sessionLine(p) : `${g.sessions.length} sessions to choose from` }),
  h('h3', { text: p.title }),
  h('div', { class: 'where', text: p.source === 'waterloo-guide' ? `${[...new Set(g.sessions.map((x) => x.facility))].join(' or ')}, Waterloo` : (p.location || 'Location not listed') }),
  h('div', { class: `age${programFits(p) ? ' fit' : ''}`, text: ageText }),
  h('div', { class: 'tags' },
    statuses.map((t) => h('span', { class: `tag${t.startsWith('Starts') ? ' open' : ' soft'}`, text: t })),
    p.fee ? h('span', { class: 'tag soft', text: [...new Set(g.sessions.map((x) => feeText(x.fee)))].join(' or ') }) : null,
    p.category ? h('span', { class: 'tag', text: p.category }) : null),
  h('div', { class: 'source', text: `From ${p.sourceName ? `the ${p.sourceName} programs page` : `the ${p.guideSeason || ''} City of Waterloo program guide`}, checked ${fmtClock(p.lastChecked)}` }));
  const el = h('article', { class: 'card' }, head);
  if (open && p.schedule) {
    const regLinks = p.registerLinks || [];
    el.append(h('div', { class: 'card-body' },
      p.description ? h('div', {}, h('h4', { text: 'About' }), h('p', { text: p.description })) : null,
      h('h4', { text: 'When and where, as the township lists it' }),
      h('ul', {}, p.schedule.map((l) => h('li', { text: l }))),
      h('h4', { text: 'Good to know' }),
      h('ul', {}, (p.derived?.notes || []).map((n) => h('li', { class: 'how', text: n }))),
      h('div', { class: 'card-actions' },
        regLinks.length
          ? regLinks.slice(0, 4).map((r) => h('a', { class: regLinks.length === 1 ? 'btn primary' : 'btn', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: /register|save|spot/i.test(r.label) || !r.label ? 'Register with the township' : `Register: ${r.label}` }))
          : h('a', { class: 'btn primary', href: p.guideUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open the township page' }),
        h('div', { class: 'pair' },
          h('button', { type: 'button', class: 'btn', text: saved ? 'Saved' : 'Save', onclick: () => toggleSaveProgram(g) }),
          h('a', { class: 'btn', href: p.guideUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Township page' })))));
  } else if (open) {
    el.append(h('div', { class: 'card-body' },
      p.description ? h('div', {}, h('h4', { text: 'About' }), h('p', { text: p.description })) : null,
      h('h4', { text: g.sessions.length === 1 ? 'When and where' : 'Sessions' }),
      h('ul', { class: 'sessions' }, g.sessions.map((x) => h('li', {},
        h('div', { text: sessionLine(x) }),
        h('div', { text: `${x.facility}. ${x.sessions} class${x.sessions === 1 ? '' : 'es'}, ${feeText(x.fee)}${x.otherFees ? ` (also ${x.otherFees})` : ''}.${x.instructor ? ` Instructor: ${x.instructor}.` : ''}` }),
        h('div', { class: 'code', text: `Registration code ${x.code}. ${programStatus(x, today).text}.` }),
        g.sessions.length > 1 ? h('button', { type: 'button', class: 'btn session-save', 'aria-pressed': state.saved[x.id] ? 'true' : 'false', text: state.saved[x.id] ? 'Saved to your calendar' : 'Save this session', onclick: () => toggleSaveSession(x) }) : null))),
      h('h4', { text: 'Good to know' }),
      h('ul', {},
        h('li', { text: programStatus(p, today).key === 'running' ? 'Already started. ActiveWaterloo shows whether late registration is still open.' : 'Not started yet. ActiveWaterloo shows whether spots are left.' }),
        p.registrationOpens ? h('li', { text: `This guide's registration opened: ${p.registrationOpens}.` }) : null,
        h('li', { class: 'how', text: 'Read from the guide (PDF). The guide doesn\'t say whether a program is full.' })),
      h('div', { class: 'card-actions' },
        h('a', { class: 'btn primary', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: `Register on ActiveWaterloo (code ${g.sessions[0].code})` }),
        h('div', { class: 'pair' },
          g.sessions.length === 1
            ? h('button', { type: 'button', class: 'btn', text: state.saved[p.id] || saved ? 'Saved' : 'Save', onclick: () => (saved ? toggleSaveProgram(g) : toggleSaveSession(p)) })
            : null,
          h('a', { class: 'btn', href: p.guideUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open the guide' })))));
  }
  return el;
}

function renderPrograms() {
  $('pkids-btn').textContent = $('kids-btn').textContent;
  for (const b of $('seg-pwho').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.pwho));
  $('p-upcoming').checked = state.pUpcoming;
  const root = $('presults');
  if (state.programsReady !== true) {
    $('psummary').textContent = '';
    root.replaceChildren(h('div', { class: 'empty' }, h('p', { text: state.programsReady || 'Loading programs...' })));
  } else {
    const { list, hiddenEnded } = filteredPrograms();
    $('psummary').textContent = `${list.length} program${list.length === 1 ? '' : 's'}${state.pwho === 'kids' ? ` stated for ages ${state.kid.min} to ${state.kid.max}` : ''}, not yet ended.${hiddenEnded ? ` ${hiddenEnded} ended sessions hidden.` : ''}`;
    root.replaceChildren(...(list.length ? list.map(programCard) : [h('div', { class: 'empty' }, h('p', { text: 'No programs match. Try a different search or "Everyone".' }))]));
  }
  const q = state.pq.trim();
  const enc = encodeURIComponent(q);
  const links = [
    ['City of Kitchener programs', `https://anc.ca.apm.activecommunities.com/activekitchener/activity/search?onlineSiteId=0&activity_select_param=2${q ? `&activity_keyword=${enc}` : ''}&viewMode=list`, q ? `searches ActiveNet for “${q}”` : 'ActiveNet program search'],
    ['City of Waterloo programs', 'https://www.waterloo.ca/activewaterloo', 'ActiveWaterloo (also has swim and drop-in)'],
    ['Township of Wilmot programs', `https://anc.ca.apm.activecommunities.com/wilmotrecweb/activity/search?onlineSiteId=0${q ? `&activity_keyword=${enc}` : ''}&viewMode=list`, q ? `searches recWeb for “${q}”` : 'recWeb program search'],
    ['Township of Wellesley programs', `https://anc.ca.apm.activecommunities.com/wellesley/activity/search?onlineSiteId=0${q ? `&activity_keyword=${enc}` : ''}&viewMode=list`, q ? `searches for “${q}”` : 'registration site'],
    ['Township of Woolwich programs', `https://anc.ca.apm.activecommunities.com/woolwich/activity/search?onlineSiteId=0&activity_select_param=2${q ? `&activity_keyword=${enc}` : ''}&viewMode=list`, q ? `searches for “${q}”` : 'Elmira, St. Jacobs, Breslau'],
    ['Township of North Dumfries programs', 'https://www.northdumfries.ca/play-and-explore/recreation-and-programs/programs/', 'Live Well North Dumfries (Ayr)'],
    ['City of Stratford programs', 'https://www.stratford.ca/en/play-here/recconnect.aspx', 'recreation registration'],
  ];
  $('pelsewhere-count').textContent = `${links.length} sites`;
  $('pelsewhere').replaceChildren(...links.map(([name, href, sub]) => h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { text: name }), h('small', { text: sub }))));
}

// A City of Waterloo program can have several sessions (different days or times);
// each is saved on its own so the calendar shows only the one you picked.
function toggleSaveSession(x) {
  const was = state.saved[x.id];
  if (was) delete state.saved[x.id];
  else state.saved[x.id] = { kind: 'program', program: x, sessions: [x], savedAt: new Date().toISOString(), event: { id: x.id, title: baseTitle(x.title), start: x.start } };
  store.set('saved', state.saved);
  render();
  toast(was ? 'Removed from your calendar.' : 'Saved to your calendar.', { label: 'Undo', run: () => { if (was) state.saved[x.id] = was; else delete state.saved[x.id]; store.set('saved', state.saved); render(); } });
}

function toggleSaveProgram(g) {
  const was = state.saved[g.id];
  if (was) delete state.saved[g.id];
  else state.saved[g.id] = { kind: 'program', program: g.first, sessions: g.sessions, savedAt: new Date().toISOString(), event: { id: g.id, title: baseTitle(g.first.title), start: g.first.start } };
  store.set('saved', state.saved);
  render();
  toast(was ? 'Removed from saved.' : 'Saved on this phone.', { label: 'Undo', run: () => { if (was) state.saved[g.id] = was; else delete state.saved[g.id]; store.set('saved', state.saved); render(); } });
}

// ---------- Live web search (via the user's own Cloudflare Worker) ----------
// Results from several searches are merged: the same page appears once, and pages from
// one website are grouped under that site so providers are easy to scan.
const web = { q: '', byUrl: new Map(), partsDone: new Set(), credits: 0 };
const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid'].forEach((k) => x.searchParams.delete(k)); return x.href.replace(/\/$/, ''); } catch { return u; } };

async function webSearch(more = false) {
  const q = state.pq.trim();
  const helper = store.get('searchUrl', '');
  if (!helper) { $('pweb-note').textContent = 'Live search isn\'t set up yet. Add your search helper address in Settings, Live search.'; return; }
  if (q.length < 2) { $('pweb-note').textContent = 'Type what you\'re looking for above first, for example piano lessons.'; return; }
  if (web.q !== q.toLowerCase()) Object.assign(web, { q: q.toLowerCase(), byUrl: new Map(), partsDone: new Set(), credits: 0 });
  const wanted = (more ? [3, 4, 5, 6] : [0, 1, 2]).filter((p) => !web.partsDone.has(p));
  if (!wanted.length) { renderWeb(q); return; }
  $('pweb-note').textContent = `Searching the web for “${q}”${more ? ' in more places' : ''}...`;
  const base = helper.replace(/\/+$/, '');
  const replies = await Promise.all(wanted.map(async (part) => {
    try {
      const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&part=${part}`, { signal: AbortSignal.timeout(25000) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { part, data, cached: res.headers.get('X-Cache') === 'hit' };
    } catch (err) {
      // Safari says "Load failed" when the helper's reply can't be read at all (wrong address,
      // starter code still in place, or the Worker crashed before answering).
      const msg = /load failed|failed to fetch|networkerror/i.test(err.message) ? `couldn't reach your search helper at ${base}`
        : /JSON/i.test(err.message) ? 'your search helper replied with something other than search results (it may still have Cloudflare\'s starter code)'
          : err.message;
      return { part, error: msg };
    }
  }));
  const errors = replies.filter((r) => r.error).map((r) => r.error);
  for (const r of replies.filter((x) => x.data)) {
    web.partsDone.add(r.part);
    if (!r.cached) web.credits++;
    for (const item of r.data.results) {
      const k = normUrl(item.url);
      const prev = web.byUrl.get(k);
      if (prev) prev.areas.add(r.data.area); else web.byUrl.set(k, { ...item, areas: new Set([r.data.area]), fetchedAt: r.data.fetchedAt });
    }
  }
  renderWeb(q, errors);
}

function renderWeb(q, errors = []) {
  const groups = new Map();
  for (const r of web.byUrl.values()) {
    if (!groups.has(r.domain)) groups.set(r.domain, []);
    groups.get(r.domain).push(r);
  }
  // Sites found by more of the searches come first: they are likelier to be local and relevant.
  const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.areas.size)) - Math.max(...a[1].map((x) => x.areas.size)) || b[1].length - a[1].length);
  const pagesN = web.byUrl.size;
  const firstDone = [0, 1, 2].some((p) => web.partsDone.has(p));
  const left = [3, 4, 5, 6].filter((p) => !web.partsDone.has(p)).length;
  if (!pagesN && errors.length) {
    $('pweb-note').textContent = `Web search didn't work: ${[...new Set(errors)].join('; ')}. In Settings, Live search, tap Test helper to see why.`;
    $('pweb-results').replaceChildren();
    return;
  }
  $('pweb-note').textContent = `${pagesN} page${pagesN === 1 ? '' : 's'} from ${groups.size} website${groups.size === 1 ? '' : 's'} for “${q}”, from ${web.partsDone.size} of 7 area searches. Not checked by Grand Calendar: open a page to confirm times, ages and prices.${errors.length ? ` Some searches failed: ${[...new Set(errors)].join('; ')}` : ''}`;
  $('pweb-results').replaceChildren(
    ...ordered.map(([domain, pages]) => h('div', { class: 'web-site' },
      h('div', { class: 'domain', text: `${domain}${pages.length > 1 ? `, ${pages.length} pages` : ''}` }),
      pages.slice(0, 4).map((r) => h('a', { class: 'web-result', href: r.url, target: '_blank', rel: 'noopener noreferrer' },
        h('h3', { text: r.title || domain }), r.snippet ? h('p', { text: r.snippet }) : null)),
      pages.length > 4 ? h('p', { class: 'how', text: `${pages.length - 4} more page${pages.length - 4 === 1 ? '' : 's'} from this site.` }) : null)),
    firstDone && left > 0 ? h('button', { type: 'button', class: 'btn', text: `Search ${left} more places (Elmira, Baden, Wellesley, Ayr, Stratford)`, onclick: () => webSearch(true) }) : null);
}

// ---------- Season alerts (web push) ----------
// The phone makes its own key pair. The public half is given to the phone's push service;
// the private half goes, with the subscription, into one code the user saves as a GitHub
// secret. Only the GitHub job can then send alerts, and only to this phone.
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export async function makePushKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  return { publicKey, privateKey };
}

async function turnOnPush() {
  const status = $('push-status');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { status.textContent = 'This browser can\'t receive alerts. On iPhone, open Grand Calendar from its Home Screen icon (iOS 16.4 or later).'; return; }
  if (!isStandalone()) { status.textContent = 'Open Grand Calendar from its Home Screen icon first, then turn on alerts there. iPhone only allows alerts for Home Screen apps.'; return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { status.textContent = 'Alerts not allowed. You can allow them later in iPhone Settings, Notifications, Grand Calendar.'; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    const keys = await makePushKeys();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(keys.publicKey) });
    const code = btoa(JSON.stringify({ v: 1, subscription: sub.toJSON(), vapid: keys }));
    $('push-code').value = code;
    $('push-code-box').hidden = false;
    store.set('push', { on: true, at: new Date().toISOString() });
    status.textContent = 'Alerts allowed on this phone. One step left:';
  } catch (err) {
    status.textContent = `Couldn't set up alerts: ${err.message}`;
  }
}

function clearAll() {
  Object.assign(state, { q: '', cost: 'any', setting: 'any', reg: 'any', hideFull: false, radius: '' });
  state.topics.clear();
  $('q').value = '';
  render();
}

function toggleSave(e) {
  const was = state.saved[e.id];
  if (was) delete state.saved[e.id];
  else {
    const { suit, topicList, ...plain } = e; // store the listing itself; rules are recomputed
    state.saved[e.id] = { event: plain, savedAt: new Date().toISOString() };
  }
  store.set('saved', state.saved);
  render();
  toast(was ? 'Removed from saved.' : 'Saved on this phone.', { label: 'Undo', run: () => { if (was) state.saved[e.id] = was; else delete state.saved[e.id]; store.set('saved', state.saved); render(); } });
}

const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function downloadIcs(e) {
  const d = (iso) => iso.replace(/-/g, '');
  const t = (hhmm) => `${hhmm.replace(':', '')}00`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Grand Calendar//EN', 'BEGIN:VEVENT',
    `UID:${icsText(e.id)}@grand-calendar`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`];
  let note = '';
  if (!e.derived.timeListed) {
    lines.push(`DTSTART;VALUE=DATE:${d(e.start.date)}`, `DTEND;VALUE=DATE:${d(addDays(e.end?.date || e.start.date, 1))}`);
    note = 'Time not listed by the source. ';
  } else {
    lines.push(`DTSTART:${d(e.start.date)}T${t(e.start.time)}`);
    if (e.end?.time) lines.push(`DTEND:${d(e.end.date)}T${t(e.end.time)}`);
    else { lines.push('DURATION:PT1H'); note = 'End time not listed by the source; 1 hour used as a placeholder. '; }
  }
  lines.push(`SUMMARY:${icsText(e.title)}`);
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  lines.push(`DESCRIPTION:${icsText(`${note}Source: ${e.url || SOURCE_NAMES[e.source]}`)}`, 'END:VEVENT', 'END:VCALENDAR');
  const ics = lines.join('\r\n') + '\r\n';
  // A downloaded .ics file is what works on iPhone: Safari offers "Save...", then the file
  // opens in Calendar. (Opening calendar data directly left a blank "data:" page; removed.)
  const blob = new Blob([ics], { type: 'text/calendar' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${e.title.slice(0, 40).replace(/[^\w ]+/g, '').trim() || 'event'}.ics` });
  document.body.append(a); a.click(); a.remove();
  toast('Calendar file ready. Tap Save, then open it to add the event to Calendar.');
}

function exportSaved() {
  const blob = new Blob([JSON.stringify({ app: 'Grand Calendar', version: 1, exportedAt: new Date().toISOString(), saved: state.saved }, null, 1)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `grand-calendar-saved-${isoOf(new Date())}.json` });
  document.body.append(a); a.click(); a.remove();
}

async function importSaved(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'Grand Calendar' || typeof data.saved !== 'object') throw new Error('not a Grand Calendar export');
    let n = 0;
    for (const [id, v] of Object.entries(data.saved)) {
      const customOk = v?.kind !== 'custom' || (v.custom && !validateCustom(v.custom));
      if (v && v.event && typeof v.event.title === 'string' && v.event.start?.date && customOk && !state.saved[id]) { state.saved[id] = v; n++; }
    }
    store.set('saved', state.saved);
    render();
    toast(`Imported ${n} saved item${n === 1 ? '' : 's'}.`);
  } catch (err) {
    toast(`Couldn't import that file: ${err.message}. Choose a file exported from Grand Calendar.`);
  }
}

function setLoc(loc) {
  state.loc = loc;
  if (loc) store.set('loc', loc); else { try { localStorage.removeItem(`${NS}loc`); } catch { /* storage off */ } }
  render();
  lookupNewVenues();
}

// ---------- Source test (run from the phone) ----------
// Reads each calendar the way the app would. Browsers hide the reason when a site
// doesn't share its pages with other sites, so a failure can mean either a block or that.
const TEST_SOURCES = [
  ['Kitchener Public Library', 'https://kpl.events.mylibrary.digital/'],
  ['City of Kitchener calendar', 'https://calendar.kitchener.ca/default/Index'],
  ['City of Waterloo calendar', 'https://events.waterloo.ca/default/Index'],
];
async function testSources() {
  const list = $('test-results');
  list.replaceChildren(h('li', { text: 'Testing...' }));
  const rows = [];
  for (const [name, url] of TEST_SOURCES) {
    let line;
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      const kind = /BEGIN:VCALENDAR/.test(text) ? 'a calendar feed' : /<html/i.test(text) ? 'a web page' : 'something else';
      line = res.ok ? `${name}: readable, HTTP ${res.status}, ${Math.round(text.length / 1024)} KB, looks like ${kind}.`
        : `${name}: answered HTTP ${res.status} (refused).`;
    } catch (err) {
      line = `${name}: not readable from here (${err.name === 'TimeoutError' ? 'timed out' : 'blocked, or the site does not share its pages with other sites'}).`;
    }
    rows.push(h('li', { text: line }));
    list.replaceChildren(...rows);
  }
  list.append(h('li', { class: 'how', text: `Tested ${fmtClock(new Date().toISOString())}.` }));
}

// ---------- Wiring ----------
function wire() {
  $('topics').replaceChildren(...TOPICS.map((t) => h('button', {
    type: 'button', class: 'chip', 'data-id': t.id, 'aria-pressed': 'false', text: t.label,
    onclick: () => { if (state.topics.has(t.id)) state.topics.delete(t.id); else state.topics.add(t.id); render(); },
  })));
  let qTimer = null;
  $('q').addEventListener('input', (ev) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = ev.target.value; render(); }, 200); });
  $('seg-dates').addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { state.dates = v; render(); } });
  $('seg-who').addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { state.who = v; render(); } });
  $('d-from').addEventListener('change', (ev) => { state.from = ev.target.value; render(); });
  $('d-to').addEventListener('change', (ev) => { state.to = ev.target.value; render(); });
  $('d-from').value = isoOf(new Date()); $('d-to').value = addDays(isoOf(new Date()), 6);
  state.from = $('d-from').value; state.to = $('d-to').value;

  $('filters-open').addEventListener('click', () => $('filters').showModal());
  $('filters').addEventListener('close', render);
  for (const g of document.querySelectorAll('[data-filter]')) {
    g.addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { state[g.dataset.filter] = v; renderControls(); } });
  }
  $('hide-full').addEventListener('change', (ev) => { state.hideFull = ev.target.checked; renderControls(); });
  $('radius').addEventListener('change', (ev) => { state.radius = ev.target.value; renderControls(); });
  $('filters-reset').addEventListener('click', () => { Object.assign(state, { cost: 'any', setting: 'any', reg: 'any', hideFull: false, radius: '' }); renderControls(); });
  $('use-gps').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('This browser can\'t share your location. Type a place instead.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc({ lat: +p.coords.latitude.toFixed(2), lng: +p.coords.longitude.toFixed(2), label: 'your location' }),
      () => toast('Location not shared. You can type a place instead.'),
      { enableHighAccuracy: false, maximumAge: 600000, timeout: 15000 },
    );
  });
  $('clear-loc').addEventListener('click', () => { state.radius = ''; setLoc(null); });
  $('place-go').addEventListener('click', async () => {
    const text = $('place').value.trim();
    if (!text) return;
    try {
      const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: `${text}, Ontario, Canada`, format: 'jsonv2', limit: '1', countrycodes: 'ca' })}`;
      const r = await (await fetch(url)).json();
      if (!r[0]) { toast('Couldn\'t find that place. Try a town or street, like Elmira or King St Waterloo.'); return; }
      setLoc({ lat: +(+r[0].lat).toFixed(2), lng: +(+r[0].lon).toFixed(2), label: r[0].display_name.split(',')[0].trim() });
    } catch { toast('Couldn\'t look up that place right now. Check your connection.'); }
  });

  const kidOpts = (sel, v) => { sel.replaceChildren(...Array.from({ length: 13 }, (_, i) => h('option', { value: String(i), text: String(i), selected: i === v }))); };
  kidOpts($('kid-min'), state.kid.min); kidOpts($('kid-max'), state.kid.max);
  const kidChange = () => {
    let min = +$('kid-min').value; let max = +$('kid-max').value;
    if (min > max) [min, max] = [max, min];
    state.kid = { min, max }; store.set('kid', state.kid); render();
  };
  $('kid-min').addEventListener('change', kidChange); $('kid-max').addEventListener('change', kidChange);
  $('settings-open').addEventListener('click', () => $('settings').showModal());
  $('refresh-now').addEventListener('click', () => { $('settings').close(); load(true); });
  $('test-sources').addEventListener('click', testSources);

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      for (const x of document.querySelectorAll('.tabs button')) {
        if (x === b) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
      }
      for (const v of ['events', 'programs', 'providers', 'saved']) $(`view-${v}`).hidden = state.view !== v;
      savePrefs();
      render();
      window.scrollTo(0, 0);
    });
  }
  let pqTimer = null;
  $('pq').addEventListener('input', (ev) => { clearTimeout(pqTimer); pqTimer = setTimeout(() => { state.pq = ev.target.value; render(); }, 200); });
  $('seg-pwho').addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { state.pwho = v; savePrefs(); render(); } });
  $('p-upcoming').addEventListener('change', (ev) => { state.pUpcoming = ev.target.checked; render(); });
  let provTimer = null;
  $('provq').addEventListener('input', (ev) => { clearTimeout(provTimer); provTimer = setTimeout(() => { state.provQ = ev.target.value; render(); }, 200); });
  $('seg-provwho').addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { state.provWho = v; savePrefs(); render(); } });
  $('prov-town').addEventListener('change', (ev) => { state.provTown = ev.target.value; savePrefs(); render(); });
  // Remember last choices, so reopening the app needs no setup.
  const prefs = store.get('prefs', {});
  if (prefs.pwho) state.pwho = prefs.pwho;
  if (prefs.provWho) state.provWho = prefs.provWho;
  if (prefs.provType !== undefined) state.provType = prefs.provType;
  if (prefs.provTown) state.provTown = prefs.provTown;
  if (prefs.view && prefs.view !== 'events') document.querySelector(`.tabs button[data-view="${prefs.view}"]`)?.click();
  state.calView = store.get('calView', 'month');
  $('seg-calview').addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { state.calView = v; state.calOpen = null; store.set('calView', v); render(); } });
  $('add-own-open').addEventListener('click', () => openAddOwn());
  $('ao-repeat').addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) setRepeat(v); });
  $('add-own-form').addEventListener('submit', saveAddOwn);
  // Clear a shown problem as soon as anything in the form changes.
  for (const t of ['input', 'click']) $('add-own-form').addEventListener(t, (ev) => { if (ev.target.id !== 'ao-save') $('ao-error').hidden = true; });
  $('ao-cancel').addEventListener('click', () => $('add-own').close());
  $('ao-ics-get').addEventListener('click', icsFromLink);
  $('ao-ics-file-btn').addEventListener('click', () => $('ao-ics-file').click());
  $('ao-ics-file').addEventListener('change', async (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) showImport(await f.text(), 'file'); });
  $('ics-preview-form').addEventListener('submit', addImported);
  $('ics-cancel').addEventListener('click', () => $('ics-preview').close());
  $('push-on').addEventListener('click', turnOnPush);
  $('pweb-go').addEventListener('click', () => webSearch(false));
  $('search-url').value = store.get('searchUrl', '');
  $('search-test').addEventListener('click', async () => {
    const v = ($('search-url').value || store.get('searchUrl', '')).trim().replace(/\/+$/, '');
    const out = $('search-test-result');
    if (!v) { out.textContent = 'Paste your helper address first.'; return; }
    if (!/^https:\/\/[\w.-]+\.workers\.dev$/.test(v)) { out.textContent = `“${v}” doesn't look like a workers.dev address, so it can't be used.`; return; }
    out.textContent = 'Testing...';
    let health;
    try {
      const res = await fetch(`${v}/health`, { signal: AbortSignal.timeout(15000) });
      health = await res.json();
    } catch {
      out.textContent = `Couldn't read a reply from ${v}/health. Open that address in Safari: if it says "Hello World", the Worker still has Cloudflare's starter code, so paste worker.js and deploy. If it shows an error page, send me a screenshot.`;
      return;
    }
    // Second check, free: the search path itself, with a too-short search that the helper
    // refuses before contacting Tavily. This proves the site lock and permission header work.
    let searchPath;
    try {
      const res = await fetch(`${v}/search?q=x&part=0`, { signal: AbortSignal.timeout(15000) });
      const d = await res.json();
      searchPath = res.status === 400 && /2 characters/.test(d.error || '') ? 'works' : `answered “${d.error || res.status}”`;
    } catch (err) {
      searchPath = `failed (${err.message})`;
    }
    // A working address is saved, so searches use the same one the test used.
    store.set('searchUrl', v);
    out.textContent = `Helper works (version ${health.version}${health.calendarLinks ? '' : ', update worker.js to version 3 for receipt calendar links'}). Tavily key: ${health.hasKey ? 'set' : 'MISSING, add TAVILY_KEY under the running Worker’s Variables and Secrets'}. Search path: ${searchPath}. Monthly cap: ${health.capOn ? `on, ${health.usedThisMonth} of ${health.cap} searches used` : 'off'}. Saved address: ${v}`;
  });
  $('search-url-save').addEventListener('click', () => {
    const v = $('search-url').value.trim();
    if (v && !/^https:\/\/[\w.-]+\.workers\.dev\/?$/.test(v)) {
      $('search-test-result').textContent = `Not saved: “${v}” doesn't look like a workers.dev address. It should look like https://name.yourname.workers.dev`;
      return;
    }
    store.set('searchUrl', v);
    $('search-test-result').textContent = v ? `Saved: ${v}. Tap Test helper to check it.` : 'Search helper removed.';
    toast(v ? 'Search helper saved.' : 'Search helper removed.');
  });
  $('push-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('push-code').value); toast('Code copied.'); } catch { $('push-code').select(); toast('Select the code and copy it.'); }
  });
  if (store.get('push', null)?.on) $('push-status').textContent = 'Alerts were turned on for this phone. Tap again only if alerts stop arriving.';
  $('export').addEventListener('click', exportSaved);
  $('import-btn').addEventListener('click', () => $('import').click());
  $('import').addEventListener('change', (ev) => { if (ev.target.files[0]) importSaved(ev.target.files[0]); ev.target.value = ''; });
}

wire();
render();
load();
loadPrograms();
loadProviders();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* alerts just won't be available */ });

// For testing in a headless browser.
window.__gc = { state, filtered, load, render, filteredPrograms, makePushKeys, savedItems };
