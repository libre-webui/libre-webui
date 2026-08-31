/*
 * Libre WebUI service worker: offline shell + Web Push display.
 *
 * Caching policy, deliberately conservative:
 * - Navigations are network-first with the cached app shell as the offline
 *   fallback, so a deployed update always wins when the network is up.
 * - Hashed build assets (/assets/*) are cache-first: their names change on
 *   every build, so a cached copy is immutable by construction.
 * - API and WebSocket traffic is never intercepted or cached; user content
 *   stays out of the Cache Storage entirely.
 */

// The cache is versioned by the registration URL's ?v= (the app version), so
// every release installs a fresh cache and activate() below prunes the old
// ones. An unversioned name once let clients keep serving a stale shell whose
// lazy chunks no longer existed on the server — the page died mid-render.
const CACHE_VERSION =
  new URLSearchParams(self.location.search).get('v') || 'v1';
const CACHE_NAME = `libre-webui-shell-${CACHE_VERSION}`;
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('libre-webui-') && key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE_NAME)
              .then(cache => cache.put('/', copy))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        cached =>
          cached ||
          fetch(request).then(response => {
            if (response.ok) {
              const copy = response.clone();
              caches
                .open(CACHE_NAME)
                .then(cache => cache.put(request, copy))
                .catch(() => undefined);
            }
            return response;
          })
      )
    );
  }
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Libre WebUI';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.type || 'libre-webui',
      data: { href: payload.href || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) {
              client.navigate(href).catch(() => undefined);
            }
            return;
          }
        }
        return self.clients.openWindow(href);
      })
  );
});
