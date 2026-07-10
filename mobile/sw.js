const CACHE = 'octomind-v7';
const ASSETS = ['/app', '/web-demo.html', '/manifest.json', '/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── Push notification received ────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: '🐙 OctoMind', body: 'Є нові нагадування!', url: '/app' };
  try { data = { ...data, ...e.data.json() }; } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon  || '/icons/icon.svg',
      badge:   data.badge || '/icons/icon.svg',
      tag:     data.tag   || 'octomind',
      data:    { url: data.url || '/?screen=calendar' },
      vibrate: [200, 100, 200],
      actions: [
        { action: 'open',    title: '📅 Відкрити' },
        { action: 'dismiss', title: 'Закрити'     },
      ],
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
      const existing = all.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
