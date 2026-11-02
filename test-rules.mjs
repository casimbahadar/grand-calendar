// Run with: node test-rules.mjs
// Uses 14 real Explore Waterloo feed events (ew-sample.ics) and real library events (wpl-sample.ics).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EW_SOURCE } from './ew-reader.mjs';
import { suitabilityOf } from './suitability.mjs';
import { topicsOf, searchMatch } from './topics.mjs';
import { mergeDuplicates, sameEvent } from './merge.mjs';
import { parseICS, normalizeEvent, SOURCES } from './gather.mjs';
import { decodeEntities, htmlToText } from './core.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

const ew = parseICS(await readFile(new URL('./ew-sample.ics', import.meta.url), 'utf8')).map((r) => normalizeEvent(r, EW_SOURCE, 'x')).filter(Boolean);
const E = (t, n = 0) => ew.filter((e) => e.title.startsWith(t))[n];
const wplSrc = SOURCES.find((s) => s.id === 'wpl');
const wpl = parseICS(await readFile(new URL('./wpl-sample.ics', import.meta.url), 'utf8')).map((r) => normalizeEvent(r, wplSrc, 'x')).filter(Boolean);

// ---------- Text ----------
check('coded characters become plain text', () => {
  assert.equal(decodeEntities('Yuk Yuk&#8217;s &amp; friends &ndash; 6&nbsp;pm'), 'Yuk Yuk’s & friends – 6 pm');
  assert.equal(htmlToText('<p>One</p><p>Two &amp; three</p>'), 'One\nTwo & three');
});

// ---------- Explore Waterloo reader (calendar feed, as the phone reads it) ----------
check('reader: 14 events, organizer details dropped', () => {
  assert.equal(ew.length, 14);
  assert.ok(!JSON.stringify(ew).includes('MAILTO'));
});
check('reader: ages read from the kids space event', () => {
  assert.match(E('There’s No Place').derived.age.text, /6 months.6 years/);
});
check('reader: Christkindl 00:00 placeholder is "hours not listed"', () => {
  const c = E('Christkindl');
  assert.equal(c.derived.timeListed, false);
  assert.equal(c.end, null);
});
check('reader: region from the address, venue key for venues.json', () => {
  assert.equal(E('Dog Mic').derived.region.place, 'Waterloo');
  assert.equal(E('Dog Mic').venueKey, 'revive karaoke|28b king street north');
});
// ---------- Suitability ----------
check('adults only: stated 19+', () => {
  const s = suitabilityOf(E('Dog Mic'));
  assert.equal(s.adultsOnly.how, 'stated');
  assert.match(s.adultsOnly.why, /19\+/);
});
check('adults only: nightclub venue is labelled inferred', () => {
  const s = suitabilityOf(E('SMILE'));
  assert.equal(s.adultsOnly.how, 'inferred');
  assert.match(s.adultsOnly.why, /Dallas Night Club/);
});
check('Nightlife: hides unless also tagged Family Friendly (Christkindl stays, speed dating hides)', () => {
  const xmas = suitabilityOf(E('Christkindl'));
  assert.equal(xmas.adultsOnly, null);
  assert.ok(xmas.notes.some((n) => n.key === 'nightlife'));
  const dating = suitabilityOf(E('Kitchener Waterloo Speed Dating'));
  assert.match(dating.adultsOnly.why, /Nightlife/);
});
check('drinks: stated in text vs inferred from venue', () => {
  const euchre = suitabilityOf(E('Euchre')).notes.find((n) => n.key === 'drinks');
  assert.equal(euchre.how, 'stated');
  assert.equal(euchre.from.toLowerCase(), 'beer');
  const bingo = suitabilityOf(E('Dirty Drag Bingo')).notes.find((n) => n.key === 'drinks');
  assert.equal(bingo.how, 'inferred');
  assert.match(bingo.from, /Brewing/);
});
check('late start, free cost, outdoor setting', () => {
  assert.ok(suitabilityOf(E('Dog Mic')).notes.some((n) => n.key === 'late'));
  assert.equal(suitabilityOf(E('Christkindl')).cost.kind, 'free'); // from the Free Events category
  assert.equal(suitabilityOf(E('Raptors')).setting.kind, 'outdoor');
});
check('library: caregiver note, indoor inferred from the room, cost not listed', () => {
  const s = suitabilityOf(wpl.find((e) => e.title.startsWith('Picturebook')));
  assert.ok(s.notes.some((n) => n.key === 'caregiver'));
  assert.deepEqual([s.setting.kind, s.setting.how], ['indoor', 'inferred']);
  assert.equal(s.cost.kind, 'not-listed');
});
check('closure listings are notices, not events', () => {
  const s = suitabilityOf({ title: 'CLOSED - Christmas Day', description: 'All locations CLOSED for Christmas Day', derived: {} });
  assert.equal(s.notice, true);
  assert.equal(suitabilityOf(E('Dog Mic')).notice, false);
});

// ---------- Topics ----------
check('topics: board games and socializing on a real euchre night', () => {
  const t = topicsOf(E('Euchre')).map((x) => x.id);
  assert.ok(t.includes('board-games'));
  assert.ok(t.includes('socializing')); // "new friends" in the description
});
check('topics: broad words only count in the title', () => {
  // "music" appears in some descriptions of non-music events; it must not count from there
  const fake = { title: 'Book launch', description: 'with live performances and music after', categories: [] };
  assert.ok(!topicsOf(fake).some((x) => x.id === 'music'));
  assert.ok(topicsOf({ title: 'Live Music at Revive', description: '', categories: [] }).some((x) => x.id === 'music'));
});
check('topics: library kids programs', () => {
  const ids = (t) => topicsOf(wpl.find((e) => e.title.startsWith(t))).map((x) => x.id);
  assert.ok(ids('Picturebook').includes('storytime'));
  assert.ok(ids('Art and STEM').includes('crafts-stem'));
});
check('search: every typed word must appear', () => {
  assert.ok(searchMatch(E('Euchre'), 'euchre beer'));
  assert.equal(searchMatch(E('Euchre'), 'euchre chess'), null);
});

// ---------- Merging ----------
check('merge: identical Billy Joel listings and the "Copy of" Miracle become one each', () => {
  const merged = mergeDuplicates(ew);
  assert.equal(merged.length, ew.length - 2);
  const bj = merged.find((e) => e.title.startsWith('Classic Albums'));
  assert.equal(bj.alsoListed.length, 1);
  const m = merged.find((e) => /Miracle on 34th/.test(e.title));
  assert.equal(m.title, 'Miracle on 34th Street'); // the original leads, not the copy
});
check('merge: two Yuk Yuk shows at different times stay separate', () => {
  assert.equal(sameEvent(E("Yuk Yuk's 50th", 0), E("Yuk Yuk's 50th", 1)), false);
});
check('merge: same program at two library branches at the same time stays separate', () => {
  const a = wpl.find((e) => e.title === 'Explore Play Learn');
  const b = { ...a, id: 'wpl:other', location: 'McCormick Branch - Program Room' };
  assert.equal(sameEvent(a, b), false);
  assert.equal(sameEvent(a, { ...a, id: 'wpl:copy' }), true);
});
check('merge: across sources, quote styles and "Copy of" are ignored', () => {
  const a = { ...E('Dog Mic'), title: "Holiday Sip & Shop at St. Jacobs Farmers' Market" };
  const b = { ...a, source: 'other', id: 'other:1', title: 'Holiday Sip & Shop at St. Jacobs Farmers’ Market' };
  assert.equal(sameEvent(a, b), true);
});

console.log(`\n${passed} rule checks passed`);
