// Grand Calendar: program guides (GitHub job, once a day).
// Downloads the City of Waterloo guide, reads it only when the file changed, and writes:
//   programs.json  the programs, with only what the guide states
//   guides.json    which guide edition was read, and when a new edition appeared
// A new edition (new season, or a changed file) is what the season alert will announce.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWaterlooGuide, WATERLOO_GUIDE } from './guide-waterloo.mjs';
import { readWellesleyPage, wellesleySeason, WELLESLEY } from './guide-wellesley.mjs';

const UA = 'GrandCalendar/0.1 (personal events digest; https://github.com/casimbahadar/grand-calendar)';
const CHECK_EVERY_MS = 20 * 60 * 60 * 1000; // about once a day
// Bump when a guide reader changes, so the next run re-reads the guide even if the PDF hasn't changed.
// 2: Waterloo swim section added.
const READER_VERSION = 2;
const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };

async function waterloo(guides, now) {
  const state = guides.guides[WATERLOO_GUIDE.id] || {};
  const readerChanged = state.readerVersion !== READER_VERSION;
  if (!readerChanged && state.checkedAt && Date.now() - Date.parse(state.checkedAt) < CHECK_EVERY_MS && !process.argv.includes('--force')) {
    console.log(`Waterloo guide checked ${state.checkedAt}; next check tomorrow.`);
    return null;
  }
  const res = await fetch(WATERLOO_GUIDE.pdf, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    guides.guides[WATERLOO_GUIDE.id] = { ...state, checkedAt: now, ok: false, error: `HTTP ${res.status}` };
    console.log(`Waterloo guide: HTTP ${res.status}; keeping the programs already read.`);
    return null;
  }
  const pdf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(pdf).digest('hex');
  if (sha === state.sha256 && !readerChanged) {
    guides.guides[WATERLOO_GUIDE.id] = { ...state, checkedAt: now, ok: true };
    console.log('Waterloo guide unchanged.');
    return null;
  }
  const dir = await mkdtemp(join(tmpdir(), 'guide-'));
  await writeFile(join(dir, 'g.pdf'), pdf);
  execFileSync('pdftotext', ['-raw', join(dir, 'g.pdf'), join(dir, 'g.txt')]);
  const parsed = readWaterlooGuide(await readFile(join(dir, 'g.txt'), 'utf8'), now);
  if (parsed.programs.length < 20) {
    // A layout change would show up as almost nothing read: keep the old programs and say so.
    guides.guides[WATERLOO_GUIDE.id] = { ...state, checkedAt: now, ok: false, error: `new file read only ${parsed.programs.length} programs; layout may have changed` };
    console.log(guides.guides[WATERLOO_GUIDE.id].error);
    return null;
  }
  const edition = parsed.season && parsed.year ? `${parsed.season} ${parsed.year}` : 'unknown';
  const isNewSeason = Boolean(state.edition) && state.edition !== edition;
  guides.guides[WATERLOO_GUIDE.id] = {
    name: WATERLOO_GUIDE.name, url: WATERLOO_GUIDE.pdf, edition, sha256: sha, checkedAt: now, readAt: now, ok: true,
    programs: parsed.programs.length, registrationOpens: parsed.registrationOpens, readerVersion: READER_VERSION,
    // newEditionAt marks when a different season's guide appeared (the alert trigger).
    newEditionAt: isNewSeason ? now : state.newEditionAt || null,
    previousEdition: isNewSeason ? state.edition : state.previousEdition || null,
    fileChangedAt: now,
  };
  console.log(`Waterloo guide (${edition}): read ${parsed.programs.length} program sessions${isNewSeason ? ', NEW EDITION' : ''}.`);
  return parsed.programs;
}

async function wellesley(guides, now) {
  const state = guides.guides[WELLESLEY.id] || {};
  if (state.checkedAt && Date.now() - Date.parse(state.checkedAt) < CHECK_EVERY_MS && !process.argv.includes('--force')) return null;
  const res = await fetch(WELLESLEY.page, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) { guides.guides[WELLESLEY.id] = { ...state, checkedAt: now, ok: false, error: `HTTP ${res.status}` }; console.log(`Wellesley: HTTP ${res.status}`); return null; }
  const html = await res.text();
  const programs = readWellesleyPage(html, now);
  if (programs.length < 5) { guides.guides[WELLESLEY.id] = { ...state, checkedAt: now, ok: false, error: `read only ${programs.length} programs; page layout may have changed` }; return null; }
  const edition = wellesleySeason(html) || 'current';
  const isNew = Boolean(state.edition) && state.edition !== edition;
  guides.guides[WELLESLEY.id] = {
    name: 'Township of Wellesley programs', url: WELLESLEY.page, edition, checkedAt: now, readAt: now, ok: true, programs: programs.length,
    newEditionAt: isNew ? now : state.newEditionAt || null, previousEdition: isNew ? state.edition : state.previousEdition || null,
  };
  console.log(`Wellesley (${edition}): read ${programs.length} programs${isNew ? ', NEW SEASON' : ''}.`);
  return programs;
}

async function main() {
  const now = new Date().toISOString();
  const guides = await readJson('guides.json', { guides: {} });
  const store = await readJson('programs.json', { programs: [] });
  let list = store.programs || [];
  const fresh = { [WATERLOO_GUIDE.id]: await waterloo(guides, now).catch((e) => { console.log(`Waterloo guide failed: ${e.message}`); return null; }),
    [WELLESLEY.id]: await wellesley(guides, now).catch((e) => { console.log(`Wellesley failed: ${e.message}`); return null; }) };
  for (const [id, programs] of Object.entries(fresh)) if (programs) list = [...list.filter((p) => p.source !== id), ...programs];
  await writeFile('programs.json', JSON.stringify({ generatedAt: now, programs: list }));
  await writeFile('guides.json', JSON.stringify(guides, null, 1));
}

main();
