// Офлайн-режим: страница — сначала сеть, потом кэш; ассеты и картинки — сначала кэш.
const CACHE = 'zchm-v4'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest', './icons/icon-192.png', './img/brand/logo-sm.png', './img/brand/logo.png'])))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))))
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  // сетевая игра, служебные адреса сервера и номер сборки — всегда напрямую, мимо кэша
  if (url.pathname.includes('/socket.io/') || url.pathname.endsWith('/health') || url.pathname.endsWith('/version.json')) return
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return r
        })
        .catch(() => caches.match('./')),
    )
    return
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((r) => {
          if (r.ok) {
            const copy = r.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return r
        }),
    ),
  )
})
