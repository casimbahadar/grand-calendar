// Grand Calendar service worker: shows alerts sent by the GitHub job, and keeps a copy of
// the app and its data so it opens with no signal.
// Online: always fetch fresh (so updates appear right away) and keep a copy.
// Offline: use the last copy. Other sites' requests (Explore Waterloo, maps) are left alone.
const CACHE = 'grandcal-v2';
const LONG_LIVED = /\.(woff2|png|svg)$/; // fonts and icons rarely change: copy first, refresh behind

// Everything the app needs to open with no signal, saved as soon as this worker installs
// (the first visit's own page loads before the worker takes over, so it can't wait for that).
const APP_FILES = ['./', 'index.html', 'app.css', 'app.mjs', 'calendar.mjs', 'ics-import.mjs', 'core.mjs', 'ages.mjs', 'ical.mjs',
  'ew-reader.mjs', 'suitability.mjs', 'topics.mjs', 'merge.mjs', 'guide-wellesley.mjs', 'manifest.webmanifest',
  'atkinson-regular.woff2', 'atkinson-bold.woff2', 'icon.svg', 'icon-180.png', 'icon-192.png',
  'events.json', 'venues.json', 'programs.json', 'providers.json', 'provider-checks.json'];
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(APP_FILES.map(async (f) => {
    try { const url = new URL(f, self.registration.scope); const res = await fetch(url, { cache: 'no-store' }); if (res.ok) await cache.put(new Request(url.origin + url.pathname), res); } catch { /* saved on a later visit */ }
  }));
  await self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // The data files are fetched with ?t=… to dodge caches; store them under one key.
  const key = new Request(url.origin + url.pathname);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (LONG_LIVED.test(url.pathname)) {
      const hit = await cache.match(key);
      const refresh = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
      return hit || (await refresh) || Response.error();
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch {
      const hit = await cache.match(key) || (url.pathname.endsWith('/') ? await cache.match(new Request(`${url.origin}${url.pathname}index.html`)) : null);
      return hit || Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Grand Calendar';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
