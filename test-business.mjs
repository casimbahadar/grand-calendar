// Run with: node test-business.mjs   (business and tech sources, from real feed samples; no network)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseICS, normalizeEvent, SOURCES, dropSameLumaEvents } from './gather.mjs';
import { topicsOf } from './topics.mjs';

const read = async (f) => readFile(new URL(f, import.meta.url), 'utf8');
const load = async (file, id) => { const src = SOURCES.find((x) => x.id === id); return parseICS(await read(file)).map((r) => normalizeEvent(r, src, '2026-11-11T00:00:00.000Z')).filter(Boolean); };
const com = await load('communitech-sample.ics', 'communitech');
const wt = await load('waterloo-tech-sample.ics', 'waterloo-tech');
const sbc = await load('sbc-sample.ics', 'small-business-centre');
const ac = await load('accelerator-sample.ics', 'accelerator-centre');
const by = (list, t) => list.find((e) => e.title.startsWith(t));
const biz = (e) => topicsOf(e).find((t) => t.id === 'business-tech');
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

await check('Luma times are converted from UTC to Toronto time', () => {
  const c = by(com, 'Coworking Day');
  assert.equal(c.start.time, '09:00'); // 14:00 UTC in November
  assert.ok(c.derived.notes.some((n) => /converted from UTC/.test(n)));
});
await check('Luma links come from the description', () => {
  assert.match(by(com, 'Coworking Day').url, /^https:\/\/luma\.com\/[A-Za-z0-9-]+$/);
});
await check('a location that is only a link is not shown as an address', () => {
  const e = com.find((x) => x.title.startsWith('AI Power Hour'));
  assert.equal(e.location, null);
  assert.ok(/^https:\/\/luma\.com\//.test(e.url));
});
await check('Toronto events on the shared calendar are marked outside the region (hidden by the app)', () => {
  const t = wt.find((e) => /Toronto/.test(e.location || ''));
  assert.equal(t.derived.region.status, 'out');
  assert.equal(by(wt, 'Pancake Social').derived.region.status, 'in');
});
await check('Small Business Centre keeps its own links; Zoom-only locations are not addresses', () => {
  const b = by(sbc, 'Business Plan 101');
  assert.match(b.url, /waterlooregionsmallbusiness\.com/);
  assert.equal(b.location, null);
  assert.equal(by(sbc, 'Demystifying').derived.region.status, 'in');
});
await check('Accelerator Centre uses each event\'s own link and venue', () => {
  const e = ac[0];
  assert.match(e.url, /^https:\/\/www\.acceleratorcentre\.com\/event-page\//);
  assert.match(e.location, /Maxwell/);
});
await check('an event with no link at all falls back to the organizer\'s events calendar, and says so', async () => {
  const src = SOURCES.find((x) => x.id === 'accelerator-centre');
  const raw = parseICS((await read('accelerator-sample.ics')).replace(/\r?\nURL[;:][^\r\n]*/g, ''))[0];
  const e = normalizeEvent(raw, src, '2026-11-11T00:00:00.000Z');
  assert.equal(e.url, 'https://www.acceleratorcentre.com/event-calendar/');
  assert.ok(e.derived.notes.some((n) => /events calendar/.test(n)));
});
await check('everything from the business sources is in Business & tech', () => {
  for (const e of [...com, ...wt, ...sbc, ...ac]) assert.ok(biz(e), e.title);
  assert.equal(biz(by(wt, 'Pancake Social')).where, 'source');
});
await check('elsewhere, only business words count; the library\'s Tech Connect help does not', () => {
  const lib = (title, description = '') => ({ source: 'wpl', title, description, categories: [] });
  assert.ok(biz(lib('Small Business Networking Breakfast')));
  assert.ok(biz(lib('Resume clinic', 'Meet local entrepreneurs and founders.')));
  assert.equal(biz(lib('Tech Connect Appointment', 'Get help with your phone or tablet.')), undefined);
});
await check('safeguard: the same Luma event on two calendars is kept once (constructed copy)', () => {
  const copy = { ...com[0], id: com[0].id.replace(/^[^:]+/, 'waterloo-tech'), source: 'waterloo-tech' };
  assert.equal(dropSameLumaEvents(com, [copy, ...wt], ['communitech']).length, wt.length);
});
console.log(`\n${passed} business checks passed`);
