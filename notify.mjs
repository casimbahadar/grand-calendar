// Grand Calendar: season alerts (GitHub job).
// Sends a notification to the phone when a program guide's new edition appears,
// or a test notification when you run the workflow with "test_push" ticked.
// PUSH_CONFIG is the code the phone showed in Settings (saved as a GitHub secret).

import { readFile, writeFile } from 'node:fs/promises';

const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };
const SUBJECT = 'https://casimbahadar.github.io/grand-calendar/';

export function alertsToSend(guides, state, test, checks = null) {
  const out = [];
  if (checks?.newFlagsAt && checks.newFlagsAt !== state.providerFlagsSeen && checks.flagged > 0) {
    out.push({ providers: checks.newFlagsAt, title: 'Grand Calendar: providers to re-check', body: `${checks.flagged} provider page${checks.flagged === 1 ? '' : 's'} changed since they were checked. Ask Claude to re-check them.`, url: './' });
  }
  if (test) out.push({ title: 'Grand Calendar test', body: 'Season alerts are working on this phone.', url: './' });
  for (const [id, g] of Object.entries(guides.guides || {})) {
    if (!g.ok || !g.edition) continue;
    const told = state.notified?.[id];
    if (!told) continue; // first time this guide is seen: remember it, don't alert
    if (told !== g.edition && g.newEditionAt) {
      const season = g.edition.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      out.push({ id, edition: g.edition, title: `New ${g.name}: ${season}`, body: g.registrationOpens ? `Registration opens: ${g.registrationOpens}` : 'The new season\'s programs are in Grand Calendar.', url: './' });
    }
  }
  return out;
}

async function main() {
  const guides = await readJson('guides.json', { guides: {} });
  const state = await readJson('notify-state.json', { notified: {} });
  state.notified ||= {};
  const test = process.env.TEST_PUSH === 'true';
  const checks = await readJson('provider-checks.json', null);
  const alerts = alertsToSend(guides, state, test, checks);
  // Remember editions seen for the first time without alerting.
  for (const [id, g] of Object.entries(guides.guides || {})) if (g.ok && g.edition && !state.notified[id]) state.notified[id] = g.edition;

  if (alerts.length && process.env.PUSH_CONFIG) {
    const { default: webpush } = await import('web-push');
    const cfg = JSON.parse(Buffer.from(process.env.PUSH_CONFIG.trim(), 'base64').toString('utf8'));
    webpush.setVapidDetails(SUBJECT, cfg.vapid.publicKey, cfg.vapid.privateKey);
    for (const a of alerts) {
      try {
        const res = await webpush.sendNotification(cfg.subscription, JSON.stringify({ title: a.title, body: a.body, url: a.url }), { TTL: 3 * 24 * 3600 });
        console.log(`sent: ${a.title} (HTTP ${res.statusCode})`);
        if (a.id) state.notified[a.id] = a.edition;
        if (a.providers) state.providerFlagsSeen = a.providers;
        state.lastSentAt = new Date().toISOString();
        state.lastError = null;
      } catch (err) {
        const gone = err.statusCode === 404 || err.statusCode === 410;
        state.lastError = gone ? 'This phone\'s alert subscription has ended. Turn on alerts again in Settings and update PUSH_CONFIG.' : `HTTP ${err.statusCode || '?'}: ${String(err.body || err.message).slice(0, 200)}`;
        console.log(`not sent: ${a.title}: ${state.lastError}`);
      }
    }
  } else if (alerts.length) {
    console.log(`${alerts.length} alert(s) waiting, but PUSH_CONFIG isn't set yet.`);
  } else {
    console.log('No alerts to send.');
  }
  await writeFile('notify-state.json', JSON.stringify(state, null, 1));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
