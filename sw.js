// Grand Calendar service worker: shows alerts sent by the GitHub job, and keeps a copy of
// the app and its data so it opens with no signal.
// Online: always fetch fresh (so updates appear right away) and keep a copy.
// Offline: use the last copy. Other sites' requests (Explore Waterloo, maps) are left alone.
const CACHE = 'grandcal-v1';
const LONG_LIVED = /\.(woff2|png|svg)$/; // fonts and icons rarely change: copy first, refresh behind

self.addEventListener('install', () => self.skipWaiting());
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
