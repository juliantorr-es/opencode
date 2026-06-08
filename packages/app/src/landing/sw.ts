/// <reference lib="webworker" />

const CACHE = "tribunus-landing-v1"

const PRECACHE_URLS: string[] = [
  "./index.html",
  "./manifest.json",
  "./public-mode.js",
  "./intake-lane.js",
  "./codex-browser.js",
]

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch(() => {
        // Precache best-effort — non-critical
      }),
    ),
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener("fetch", (event: FetchEvent) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return

  // Never cache API or intake submission endpoints
  if (url.pathname.includes("/api/") || url.pathname.includes("/intake")) {
    event.respondWith(fetch(request).catch(() => new Response(null, { status: 503 })))
    return
  }

  // Network-first for HTML, cache-first for static assets
  const isNavigational = request.mode === "navigate" || url.pathname.endsWith(".html")

  if (isNavigational) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone()
          caches.open(CACHE).then((cache) => cache.put(request, clone))
          return res
        })
        .catch(() => caches.match(request).then((cached) => cached ?? new Response(null, { status: 503 }))),
    )
  } else {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((res) => {
            const clone = res.clone()
            caches.open(CACHE).then((cache) => cache.put(request, clone))
            return res
          }),
      ),
    )
  }
})

export {}
