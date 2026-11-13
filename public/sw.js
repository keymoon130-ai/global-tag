// 글로벌 술래잡기 서비스 워커: 화면이 꺼져 있어도 알림을 띄워요
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '글로벌 술래잡기', body: e.data ? e.data.text() : '' }; }
  const urgent = d.tag === 'urgent';
  e.waitUntil(self.registration.showNotification(d.title || '글로벌 술래잡기', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: urgent ? 'gt-urgent' : 'gt-' + Date.now(),
    renotify: true,
    requireInteraction: urgent,
    vibrate: urgent ? [600, 200, 600, 200, 600, 200, 600] : [300, 120, 300],
    data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  })());
});
