// Grand Calendar: facts about an event that matter for who should go.
// Every flag says how it was decided: 'stated' (the source says so) or
// 'inferred' (worked out from something else, such as the venue's name).
// Browser-safe.
//
// suitabilityOf(event) -> {
//   adultsOnly: null | { why, how }   hard-hidden in kids and family modes
//   notes: [{ key, label, how, from }] soft: pushed down in family mode, never hidden
//   cost: { kind: 'free' | 'paid' | 'not-listed', text, how }
//   setting: null | { kind: 'indoor' | 'outdoor', how, from }
//   cancelled: null | { how, from }
//   notice: boolean   a closure notice ("All locations CLOSED"), not an event
// }

// Explore Waterloo's "Nightlife" category is set by organizers. It sometimes sits on
// family events too (Christkindl Market is tagged both Family Friendly and Nightlife).
// Rule (decision, Nov 2 2026): Nightlife hides an event in kids and family modes
// unless the source also tags it Family Friendly; then it only adds a soft note.

const WORD = (re) => new RegExp(`\\b(?:${re})\\b`, 'i');

const DRINK_TEXT = WORD('cash bar|licensed|licenced|bar service|full bar|beer|beers|wine|wines|cocktails?|craft brews?|pints?|whisk(?:e)?y|bourbon|tequila|sangria|mimosas?|happy hour|pub crawl|brewery tour');
const DRINK_VENUE = WORD('brew(?:ing|ery|pub|house)|taproom|tap room|pub|tavern|saloon|distillery|winery|bar|lounge');
const NIGHTCLUB_VENUE = WORD('night ?club');
const OUTDOOR = WORD('outdoors?|outside|rain or shine|open[- ]air|on the lawn|in the park');
const INDOOR = WORD('indoors?');
const CANCELLED = WORD('cancell?ed|postponed');
const FREE_TEXT = WORD('free admission|admission is free|free entry|free event|free to attend|no cover|free outdoor screening|free for all');

const hasCat = (e, re) => (e.categories || []).some((c) => re.test(c));

function match(re, text) {
  const m = re.exec(text);
  return m ? m[0] : null;
}

export function suitabilityOf(e) {
  const text = `${e.title}\n${e.description || ''}`;
  const venue = e.venue || (e.location ? e.location.split(',')[0] : '') || '';
  const age = e.derived?.age;
  const notes = [];

  // Hard hide: only clear adult limits (decision: 19+, adults only, Nightlife, nightclub venue)
  let adultsOnly = null;
  if (age && age.kind === 'minimum' && age.min >= 18) adultsOnly = { why: `source says "${age.text}"`, how: 'stated' };
  else if (hasCat(e, /^nightlife$/i) && !hasCat(e, /^family[- ]friendly$/i)) adultsOnly = { why: 'listed under Nightlife by the source', how: 'stated' };
  else if (match(NIGHTCLUB_VENUE, venue)) adultsOnly = { why: `venue "${venue}" is a nightclub`, how: 'inferred' };

  // Soft notes
  const drinkWords = match(DRINK_TEXT, text);
  if (drinkWords) notes.push({ key: 'drinks', label: 'Alcohol mentioned', how: 'stated', from: drinkWords });
  else if (match(DRINK_VENUE, venue)) notes.push({ key: 'drinks', label: 'Venue may serve alcohol', how: 'inferred', from: venue });

  if (!adultsOnly && hasCat(e, /^nightlife$/i)) {
    notes.push({ key: 'nightlife', label: 'Also listed under Nightlife', how: 'stated', from: 'source category' });
  }
  if (e.derived?.timeListed && e.start?.time && e.start.time >= '20:00') {
    notes.push({ key: 'late', label: 'Starts 8 pm or later', how: 'stated', from: e.start.time });
  }
  if (age?.caregiver) notes.push({ key: 'caregiver', label: 'Caregiver must attend', how: 'stated', from: age.text });

  // Cost: only what the source says
  let cost = { kind: 'not-listed', text: null, how: null };
  if (e.cost) {
    cost = /free/i.test(e.cost) && !/\d/.test(e.cost)
      ? { kind: 'free', text: e.cost, how: 'stated' }
      : { kind: /\d/.test(e.cost) ? 'paid' : 'not-listed', text: e.cost, how: 'stated' };
  } else {
    const f = match(FREE_TEXT, text);
    if (f) cost = { kind: 'free', text: f, how: 'stated' };
  }

  // Indoor / outdoor
  let setting = null;
  const out = match(OUTDOOR, text);
  const inn = match(INDOOR, text);
  if (out && !inn) setting = { kind: 'outdoor', how: 'stated', from: out };
  else if (inn && !out) setting = { kind: 'indoor', how: 'stated', from: inn };
  else if (!out && !inn && /\b(program room|branch|library)\b/i.test(e.location || '')) {
    setting = { kind: 'indoor', how: 'inferred', from: e.location };
  }

  // Cancelled: the feed's own status, or the word in the title
  let cancelled = null;
  if (e.status === 'CANCELLED') cancelled = { how: 'stated', from: 'source status' };
  else if (match(CANCELLED, e.title)) cancelled = { how: 'stated', from: match(CANCELLED, e.title) };

  // Library closure listings: "CLOSED - Christmas Day", "All locations CLOSED for holidays"
  const notice = /^\s*closed\b/i.test(e.title) || /\ball (?:locations|branches) (?:are )?closed\b/i.test(e.description || '');

  return { adultsOnly, notes, cost, setting, cancelled, notice };
}
