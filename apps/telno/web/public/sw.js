/*
 * A service worker whose whole job is to make the softphone installable.
 *
 * It caches nothing, on purpose. This application is an operator console against
 * a live switch: a stale bundle is a phone that cannot dial, and a stale API
 * response is worse than no response. So every request goes to the network and
 * the cache API is never touched — an offline-first app store this is not, a
 * browser that lets you install it as a window is.
 *
 * If offline behaviour is ever wanted, it belongs in an explicit offline page,
 * not in a cache that quietly answers for the platform.
 */

self.addEventListener('install', () => {
  // Take over as soon as the operator reloads, rather than waiting for every
  // tab of the console to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // No respondWith() — the browser performs the request exactly as it would
  // without a worker. The handler exists because installability requires one.
  if (event.request.method !== 'GET') return;
});
