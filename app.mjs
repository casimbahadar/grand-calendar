// Grand Calendar app. Plain ES module, no build step.
// Source text is only ever inserted as text (never as HTML), so a listing can't inject code.

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
  return hrs < 24 ? `${hrs} hour${hrs === 1 ? '' : 's'} ago` : `${Math.round(hrs / 24)} days ago`;
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
  if (state.view === 'events') renderEvents(); else renderSaved();
  renderElsewhere();
  $('saved-count').textContent = Object.keys(state.saved).length ? `(${Object.keys(state.saved).length})` : '';
}

function renderStatus() {
  if (!state.status.length) return;
  const bad = state.status.filter((s) => !s.ok).length;
  const oldest = state.status.filter((s) => s.ok && s.at).map((s) => s.at).sort()[0];
  $('status-summary').textContent = `${oldest ? `Updated ${ago(oldest)}` : 'Not updated'}${bad ? `, ${bad} problem${bad === 1 ? '' : 's'}` : ''}`;
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

function renderSaved() {
  const root = $('saved-list');
  const entries = Object.values(state.saved).sort((a, b) => a.event.start.date.localeCompare(b.event.start.date));
  if (!entries.length) {
    root.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'Nothing saved yet. Open an event and tap Save to keep it here.' })));
    return;
  }
  const today = isoOf(new Date());
  root.replaceChildren(...entries.map((s) => {
    const live = state.events.find((e) => e.id === s.event.id);
    const e = live || s.event;
    const el = card({ e, tier: state.who === 'kids' ? kidTier(e) : null, push: [], dist: state.loc && e.geo ? km(state.loc, e.geo) : null }, { inSaved: true });
    if (!live) el.querySelector('.source').textContent = (e.end?.date || e.start.date) < today ? 'This event has passed.' : 'No longer in the source listings. It may have been removed or changed; check the source.';
    return el;
  }));
}

function renderElsewhere() {
  const q = state.q.trim() || [...state.topics].map((id) => TOPICS.find((t) => t.id === id)?.label).filter(Boolean)[0] || '';
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const enc = encodeURIComponent(q);
  const links = [
    ['Kitchener Public Library', 'https://kpl.events.mylibrary.digital/', 'events calendar'],
    ['City of Kitchener', 'https://calendar.kitchener.ca/default/Index', 'community calendar'],
    ['City of Waterloo', 'https://events.waterloo.ca/default/Index', 'events calendar'],
    ['Eventbrite', slug ? `https://www.eventbrite.ca/d/canada--kitchener/${slug}/` : 'https://www.eventbrite.ca/d/canada--kitchener/events/', q ? `searches for “${q}”` : 'Kitchener area'],
    ['Meetup', q ? `https://www.meetup.com/find/?keywords=${enc}&location=ca--on--Kitchener&source=EVENTS` : 'https://www.meetup.com/find/ca--on--kitchener/', q ? `searches for “${q}”` : 'Kitchener area'],
    ['Luma', 'https://lu.ma/discover', 'discover events'],
  ];
  $('elsewhere').replaceChildren(...links.map(([name, href, sub]) => h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { text: name }), h('small', { text: sub }))));
}

// ---------- Actions ----------
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
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${e.title.slice(0, 40).replace(/[^\w ]+/g, '').trim() || 'event'}.ics` });
  document.body.append(a); a.click(); a.remove();
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
      if (v && v.event && typeof v.event.title === 'string' && v.event.start?.date && !state.saved[id]) { state.saved[id] = v; n++; }
    }
    store.set('saved', state.saved);
    render();
    toast(`Imported ${n} saved event${n === 1 ? '' : 's'}.`);
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

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      for (const x of document.querySelectorAll('.tabs button')) {
        if (x === b) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
      }
      $('view-events').hidden = state.view !== 'events';
      $('view-saved').hidden = state.view !== 'saved';
      render();
      window.scrollTo(0, 0);
    });
  }
  $('export').addEventListener('click', exportSaved);
  $('import-btn').addEventListener('click', () => $('import').click());
  $('import').addEventListener('change', (ev) => { if (ev.target.files[0]) importSaved(ev.target.files[0]); ev.target.value = ''; });
}

wire();
render();
load();

// For testing in a headless browser.
window.__gc = { state, filtered, load, render };
