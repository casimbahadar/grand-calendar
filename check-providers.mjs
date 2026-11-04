// Grand Calendar: monthly provider check (GitHub job).
// For each provider in providers.json, revisit its own page and:
//   1. confirm each recorded age ("stated") still appears in the provider's own words
//   2. fingerprint every age phrase on the page; a different fingerprint means the
//      page's classes or ages changed (often a new season)
// Results go to provider-checks.json. The app shows "may be out of date" on flagged
// cards, and notify.mjs sends one alert when new flags appear. Nothing is changed in
// providers.json itself: a person re-checks and updates it.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Some sites turn away requests that don't look like a browser; this still names Grand Calendar.
const UA = 'Mozilla/5.0 (compatible; GrandCalendar/0.1; monthly provider check; +https://github.com/casimbahadar/grand-calendar)';
const EVERY_MS = 28 * 24 * 60 * 60 * 1000;
// Age phrasings providers use: "Ages 3-5", "aged 5-14", "4 to 7 years old", "5+ years old",
// "Kids 4+", "5- and 6-Year-Old", "age 5 years and up". (U7-style labels are left out on purpose:
// team lists change every week and would cause false alarms.)
const AGE = /(?:\bage[sd]?\s*:?\s*\d{1,2}(?:\.\d)?\s*(?:\+|(?:-|–|—|to)\s*\d{1,2}(?:\.\d)?)?(?:\s*(?:years?|yrs|months?))?|\b\d{1,2}(?:\.\d)?\s*(?:-|–|to)\s*\d{1,2}(?:\.\d)?\s*(?:years?|yrs|year-olds?|months?)\b|\b\d{1,2}\s*\+\s*(?:years?|yrs)\b|\bkids\s*\d{1,2}\s*\+|\b\d{1,2}(?:-?\s*(?:and|&)\s*\d{1,2})?[- ]year[- ]olds?\b)/gi;
const SKIP_JS = /jquery|bootstrap|swiper|moment|wow|waypoint|analytics|gtag|polyfill/i;

const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—');
}
const visible = (s) => decodeEntities(s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' \n '));
const unescapeJs = (s) => decodeEntities(s.replace(/\\u002F|\\\//g, '/').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/<[^>]+>/g, ' '));
// Compare text loosely: case, spacing and dash style don't count as a change.
export const loose = (s) => s.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').trim();

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { final: res.url || url, body: await res.text() };
}

// Everything the provider's own page says: visible text, embedded page data, and its own scripts.
export async function pageText(url) {
  const { final, body } = await fetchText(url);
  const host = new URL(final).hostname;
  const parts = [visible(body), unescapeJs([...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join(' '))];
  const scripts = [...body.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => new URL(m[1], final).href)
    .filter((u) => new URL(u).hostname === host && !SKIP_JS.test(u)).slice(0, 6);
  for (const u of scripts) {
    try { parts.push(unescapeJs((await fetchText(u)).body)); } catch { /* skip that file */ }
    await sleep(500);
  }
  return parts.join('\n');
}

export function fingerprint(text) {
  const phrases = [...new Set([...text.matchAll(AGE)].map((m) => loose(m[0])))].sort();
  return { hash: createHash('sha256').update(phrases.join('|')).digest('hex').slice(0, 16), phrases };
}

export function checkProvider(p, text, previous) {
  const lt = loose(text);
  const missing = (p.classes || []).filter((c) => c.stated && !lt.includes(loose(c.stated))).map((c) => c.stated);
  const fp = fingerprint(text);
  const changed = Boolean(previous?.hash) && previous.hash !== fp.hash;
  const added = changed ? fp.phrases.filter((x) => !(previous.phrases || []).includes(x)).slice(0, 8) : [];
  const removed = changed ? (previous.phrases || []).filter((x) => !fp.phrases.includes(x)).slice(0, 8) : [];
  const status = missing.length ? 'missing' : changed ? 'changed' : 'ok';
  return { status, missing, hash: fp.hash, phrases: fp.phrases.slice(0, 60), added, removed };
}

async function main() {
  const force = process.argv.includes('--force');
  const store = await readJson('provider-checks.json', { checkedAt: null, results: {} });
  if (!force && store.checkedAt && Date.now() - Date.parse(store.checkedAt) < EVERY_MS) {
    console.log(`Providers checked ${store.checkedAt}; next check in about a month.`);
    return;
  }
  const { providers = [] } = await readJson('providers.json', {});
  const now = new Date().toISOString();
  const results = {};
  for (const p of providers) {
    const url = /^https?:/.test(p.source || '') ? p.source : p.url;
    const prev = store.results[p.id];
    if (p.check) { results[p.id] = { status: 'manual', reason: p.check, url, fetchedAt: now }; console.log(`manual      ${p.name}`); continue; }
    try {
      const pages = [...new Set([url, ...(p.pages || [])])];
      const texts = [];
      for (const u of pages) { texts.push(await pageText(u)); await sleep(800); }
      const text = texts.join('\n');
      const r = checkProvider(p, text, prev);
      // A trial or drop-in offer is checked on its own page, kept out of the fingerprint so the
      // baseline stays comparable: if the offer's wording is gone, it's flagged as missing.
      if (p.tryFirst?.stated) {
        let tt = text;
        if (p.tryFirst.page && !pages.includes(p.tryFirst.page)) { try { tt = await pageText(p.tryFirst.page); } catch { tt = ''; } }
        if (!loose(tt).includes(loose(p.tryFirst.stated))) { r.missing.push(`trial offer “${p.tryFirst.stated}”`); r.status = 'missing'; }
      }
      // A flag stays until someone re-checks the provider (its "checked" date moves past the flag).
      const stillFlagged = prev && prev.status !== 'ok' && prev.flaggedAt && p.checked < prev.flaggedAt.slice(0, 10);
      const status = r.status !== 'ok' ? r.status : stillFlagged ? prev.status : 'ok';
      results[p.id] = { ...r, status, url, fetchedAt: now, flaggedAt: status === 'ok' ? null : (prev?.flaggedAt && prev.status !== 'ok' ? prev.flaggedAt : now) };
    } catch (err) {
      results[p.id] = { ...(prev || {}), status: 'unreachable', error: String(err.message || err), url, fetchedAt: now, flaggedAt: prev?.flaggedAt || now };
    }
    console.log(`${results[p.id].status.padEnd(11)} ${p.name}${results[p.id].missing?.length ? ` (not found: ${results[p.id].missing.join('; ')})` : ''}`);
    await sleep(1500);
  }
  const needsLook = (r) => r.status !== 'ok' && r.status !== 'manual';
  const flagged = Object.values(results).filter(needsLook).length;
  const before = Object.values(store.results || {}).filter(needsLook).length;
  await writeFile('provider-checks.json', JSON.stringify({ checkedAt: now, flagged, newFlagsAt: flagged > before ? now : store.newFlagsAt || null, results }, null, 1));
  console.log(`Checked ${providers.length} providers: ${flagged} need a look.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
