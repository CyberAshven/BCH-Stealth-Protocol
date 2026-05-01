(() => {
  const CACHE = "bch-stealth-wallet-v506";
  const APP_SHELL = [
    "/",
    "/index.html",
    "/shell.js",
    "/ws-shared.js",
    "/ws-bridge.js",
    "/desktop.css",
    "/chains.js",
    "/ledger.js",
    "/wizardconnect.js",
    "/app.js",
    "/router.js",
    "/manifest.json",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-180.png",
    "/icons/bch.png",
    "/icons/btc.png",
    "/icons/eth.png",
    "/icons/xmr.png",
    "/icons/usdc.png",
    "/icons/usdt.png"
  ];
  const NETWORK_FIRST = [
    "midgard.ninerealms.com",
    "thornode.ninerealms.com",
    "fulcrum.cash",
    "bchd.fountainhead.cash",
    "cauldron.quest",
    "oracle.cauldron.quest",
    "api.kraken.com",
    "delphi.cash",
    "relay.damus.io",
    "nos.lol",
    "relay.snort.social",
    "node.moneroworld.com",
    "xmr-node.cakewallet.com",
    "nodes.hashvault.pro",
    "fonts.googleapis.com",
    "fonts.gstatic.com"
  ];
  self.addEventListener("install", (e) => {
    e.waitUntil(
      caches.open(CACHE).then((c) => Promise.all(
        APP_SHELL.map(
          (url) => fetch(url, { cache: "no-store" }).then((r) => c.put(url, r))
        )
      )).then(() => self.skipWaiting())
    );
  });
  self.addEventListener("activate", (e) => {
    e.waitUntil(
      caches.keys().then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      )).then(() => self.clients.claim())
    );
  });
  const COI_PAGES = ["/swap-xmr.html", "/swap.html"];
  function addCoiHeaders(response) {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  self.addEventListener("fetch", (e) => {
    const url = e.request.url;
    if (e.request.method !== "GET") return;
    if (url.startsWith("chrome-extension")) return;
    if (url.startsWith("ws://") || url.startsWith("wss://")) return;
    const needsCoi = COI_PAGES.some((p) => new URL(url).pathname.endsWith(p));
    const isNetworkFirst = NETWORK_FIRST.some((h) => url.includes(h));
    if (isNetworkFirst) {
      e.respondWith(
        fetch(e.request).then((r) => needsCoi ? addCoiHeaders(r) : r).catch(
          () => caches.match(e.request, { ignoreSearch: true }).then((c) => c || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }))
        )
      );
    } else {
      const isHtml = url.endsWith(".html") || url.endsWith("/") || url.endsWith("shell.js") || url.endsWith("desktop.css") || url.includes("/core/") || url.includes("/views/") || url.includes("/services/") || url.endsWith("app.js") || url.endsWith("router.js") || url.endsWith("chains.js");
      if (isHtml) {
        e.respondWith(
          caches.match(e.request, { ignoreSearch: true }).then((cached) => {
            const fetchPromise = fetch(e.request, { cache: "no-cache" }).then((res) => {
              if (res.ok) {
                const clone = res.clone();
                caches.open(CACHE).then((c) => c.put(e.request, clone));
              }
              return needsCoi ? addCoiHeaders(res) : res;
            }).catch(() => cached);
            return cached ? needsCoi ? addCoiHeaders(cached) : cached : fetchPromise;
          })
        );
      } else {
        e.respondWith(
          caches.match(e.request, { ignoreSearch: true }).then((cached) => {
            if (cached) return needsCoi ? addCoiHeaders(cached) : cached;
            return fetch(e.request).then((res) => {
              const clone = res.clone();
              if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, clone));
              return needsCoi ? addCoiHeaders(res) : res;
            });
          })
        );
      }
    }
  });
  self.addEventListener("push", (e) => {
    if (!e.data) return;
    const { title = "BCH Stealth Wallet", body = "", url = "/" } = e.data.json();
    e.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url }
      })
    );
  });
  self.addEventListener("notificationclick", (e) => {
    e.notification.close();
    e.waitUntil(clients.openWindow(e.notification.data?.url || "/"));
  });
})();
