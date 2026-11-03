// Grand Calendar: Meetup test (milestone 6).
// Tries Meetup's documented server-to-server sign-in (the "JWT flow" at
// meetup.com/api/authentication), then one event search near Kitchener.
// Writes meetup-probe.json with what worked and what didn't. Never writes keys or tokens.
//
// Needs four GitHub secrets (see the setup steps in chat):
//   MEETUP_CLIENT_KEY, MEETUP_MEMBER_ID, MEETUP_SIGNING_KEY_ID, MEETUP_PRIVATE_KEY

import { createSign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const OUT = 'meetup-probe.json';
const env = process.env;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function signedJwt() {
  const header = { kid: env.MEETUP_SIGNING_KEY_ID, typ: 'JWT', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: env.MEETUP_MEMBER_ID, iss: env.MEETUP_CLIENT_KEY, aud: 'api.meetup.com', exp: now + 120 };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  // GitHub secrets sometimes lose line breaks; restore them if the key arrives on one line.
  let key = env.MEETUP_PRIVATE_KEY;
  if (!key.includes('\n')) key = key.replace(/(-----BEGIN [A-Z ]+-----)\s*/, '$1\n').replace(/\s*(-----END [A-Z ]+-----)/, '\n$1');
  return `${body}.${b64url(signer.sign(key))}`;
}

// Two query shapes, because guides disagree on Meetup's current search fields.
const QUERIES = {
  keywordSearch: `query($lat: Float!, $lon: Float!) {
    keywordSearch(filter: { query: "games", lat: $lat, lon: $lon, radius: 25, source: EVENTS }, input: { first: 5 }) {
      count
      edges { node { result { ... on Event { id title dateTime eventUrl venue { name city lat lng } } } } }
    }
  }`,
  eventSearch: `query($lat: Float!, $lon: Float!) {
    eventSearch(filter: { query: "games", lat: $lat, lon: $lon, radius: 25 }, first: 5) {
      totalCount
      edges { node { id title dateTime eventUrl venue { name city lat lng } } }
    }
  }`,
};

async function main() {
  const out = { ranAt: new Date().toISOString(), steps: [] };
  const missing = ['MEETUP_CLIENT_KEY', 'MEETUP_MEMBER_ID', 'MEETUP_SIGNING_KEY_ID', 'MEETUP_PRIVATE_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    out.steps.push({ step: 'secrets', ok: false, detail: `not set yet: ${missing.join(', ')}` });
    await writeFile(OUT, JSON.stringify(out, null, 1));
    console.log('Meetup test skipped: secrets not set yet.');
    return;
  }
  let token = null;
  try {
    const res = await fetch('https://secure.meetup.com/oauth2/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt() }),
    });
    const data = await res.json().catch(() => ({}));
    token = data.access_token || null;
    out.steps.push({ step: 'sign in', ok: Boolean(token), detail: token ? `HTTP ${res.status}, token received` : `HTTP ${res.status}, ${data.error || 'no token'}${data.error_description ? `: ${data.error_description}` : ''}` });
  } catch (err) {
    out.steps.push({ step: 'sign in', ok: false, detail: String(err.message || err) });
  }
  if (token) {
    for (const [name, query] of Object.entries(QUERIES)) {
      try {
        const res = await fetch('https://api.meetup.com/gql', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { lat: 43.4516, lon: -80.4925 } }),
        });
        const data = await res.json().catch(() => ({}));
        const root = data.data && data.data[name];
        const edges = root?.edges || [];
        const titles = edges.map((e) => (e.node.result || e.node)?.title).filter(Boolean);
        out.steps.push({
          step: `search (${name})`, ok: Boolean(root), http: res.status,
          detail: root ? `${titles.length} events returned` : (data.errors || []).map((e) => e.message).join(' | ').slice(0, 400) || 'no data',
          sampleTitles: titles,
        });
      } catch (err) {
        out.steps.push({ step: `search (${name})`, ok: false, detail: String(err.message || err) });
      }
    }
  }
  await writeFile(OUT, JSON.stringify(out, null, 1));
  for (const s of out.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step}: ${s.detail}`);
}

main();
