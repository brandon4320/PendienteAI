// Service Worker — PendienteAI
// Maneja notificaciones push y el click en notificaciones.

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'PendienteAI', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'PendienteAI', {
      body: data.body || '',
      tag: data.tag || 'pendiente',
      renotify: !!data.renotify,
      requireInteraction: !!data.requireInteraction,
      data: { url: data.url || 'https://pendienteia.vercel.app' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || 'https://pendienteia.vercel.app';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith('https://pendienteia.vercel.app') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
