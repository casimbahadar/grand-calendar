// Run with: node test-providers.mjs   (checks the monthly provider check's logic, no network)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkProvider, fingerprint, loose } from './check-providers.mjs';
import { alertsToSend } from './notify.mjs';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };
const prov = { id: 'x', classes: [{ name: 'Sr Kindergym', stated: 'Girls/Boys (5-6 years old)' }, { name: 'Kindergym', stated: 'Ages 3–5' }] };
const page = 'Kindergym Ages 3 - 5. Sr Kindergym Girls/Boys (5-6 years old). Girls Gym Girls 6-9 years old.';

await check('recorded ages found, even with different spacing and dash style', () => {
  const r = checkProvider(prov, page, null);
  assert.equal(r.status, 'ok'); assert.deepEqual(r.missing, []);
  assert.equal(loose('Ages 3–5'), loose('ages 3 - 5'));
});
await check('a recorded age that disappears is flagged as missing', () => {
  const r = checkProvider(prov, 'Kindergym Ages 3-5. Girls Gym 6-9 years old.', null);
  assert.equal(r.status, 'missing'); assert.deepEqual(r.missing, ['Girls/Boys (5-6 years old)']);
});
await check('new ages on the page are flagged as changed, with what was added', () => {
  const before = checkProvider(prov, page, null);
  const r = checkProvider(prov, `${page} NEW: Mini Gym ages 4-6 years.`, { hash: before.hash, phrases: before.phrases });
  assert.equal(r.status, 'changed'); assert.ok(r.added.some((a) => a.includes('4-6')));
});
await check('the same page next month is not flagged', () => {
  const before = checkProvider(prov, page, null);
  assert.equal(checkProvider(prov, page, { hash: before.hash, phrases: before.phrases }).status, 'ok');
  assert.equal(fingerprint(page).hash, fingerprint(page.replace(/\s+/g, '  ')).hash);
});
await check('every provider records its ages in a form the checker can match', async () => {
  const { providers } = JSON.parse(await readFile(new URL('./providers.json', import.meta.url), 'utf8'));
  for (const p of providers) for (const c of p.classes || []) {
    assert.equal(typeof c.stated, 'string', `${p.name} ${c.name} needs stated text`);
    assert.ok(c.min === null || typeof c.min === 'number', `${p.name} ${c.name} min`);
  }
});
await check('wordings met while widening the directory are noticed', () => {
  const phrases = fingerprint('Perfect for kids and youth aged 5-14. Art Classes for Kids 4+. CanSkate 5+ years old. Mini Coderz Ages 7-8. our 5- and 6-Year-Old Class. U7 Leafs U7 Oilers').phrases;
  for (const want of ['aged 5-14', 'kids 4+', '5+ years', 'ages 7-8', '6-year-old']) assert.ok(phrases.some((p) => p.includes(want)), `missed "${want}" in ${JSON.stringify(phrases)}`);
  assert.ok(!phrases.some((p) => /u7/i.test(p)), 'team labels must not count');
});
await check('one phone alert for new flags, not repeated', () => {
  const checks = { flagged: 2, newFlagsAt: '2026-12-03T10:00:00Z' };
  const a = alertsToSend({ guides: {} }, { notified: {} }, false, checks);
  assert.equal(a.length, 1); assert.match(a[0].body, /2 provider pages changed/);
  assert.equal(alertsToSend({ guides: {} }, { notified: {}, providerFlagsSeen: '2026-12-03T10:00:00Z' }, false, checks).length, 0);
});
console.log(`\n${passed} provider checks passed`);
