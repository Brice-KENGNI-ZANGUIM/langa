// Service worker — mode hors-ligne de l'app de collecte.
// Stratégie : RÉSEAU D'ABORD pour la coquille (on obtient toujours la dernière
// version quand on est connecté ; le cache ne sert que de secours hors-ligne),
// et l'API n'est jamais mise en cache. Bumper CACHE à chaque évolution de la
// coquille purge l'ancien cache.
const CACHE = "collecte-nge-v253";
const SHELL = [
  "./",
  "./index.html",
  "./fonts.css",
  "./app.css",
  "./app.js",
  "./db.js",
  "./sync.js",
  "./config.js",
  "./languages.js",
  "./langpacks.js",
  "./export.js",
  "./share.js",
  "./langsim.js",
  "./langmerge.js",
  "./amorce.js",
  "./predict.js",
  "./lexique.data.js",
  "./audioplayer.js",
  "./i18n.js",
  "./source_en.js",
  "./audiotrim.js",
  "./legal.js",
  "./propositions.js",
  "./bugs.js",
  "./version.json",
  "./manifest.webmanifest",
  "./icons/logo.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/act-translate.svg",
  "./icons/act-transcribe.svg",
  "./icons/mic-real.png",
  "./icons/act-explore.svg",
  "./icons/act-request.png",
  "./icons/cur-pointer.png",
  "./icons/ui/hi-home.png",
  "./icons/ui/hi-lang.png",
  "./icons/ui/hi-about.png",
  "./icons/ui/hi-help.png",
  "./icons/ui/hi-bug.png",
  "./icons/ui/hi-theme.svg",
  "./icons/ui/hi-profile.png",
  "./icons/ui/hi-notif.png",
  "./icons/two-talk.webp",
  "./icons/pop-request.webp",
  "./icons/pop-contribute.webp",
  "./icons/pop-rate.webp",
  "./flyer/qr.png",
  "./keyboard/ngiemboon-keyboard.js",
  "./keyboard/ngiemboon-keyboard.css",
  "./keyboard/alphabet.data.js",
  "./keyboard/alphabets_afrique.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Le bouton « Mettre à jour » de l'app envoie ce message → on active tout de suite
// le nouveau SW (sans attendre la fermeture de tous les onglets), puis l'app recharge.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Requêtes CROSS-ORIGIN (ex. envoi vers le Google Apps Script) : le SW ne s'en
  // mêle pas — le navigateur les gère normalement (sinon on tenterait de mettre
  // en cache un POST cross-origin, ce qui échoue).
  if (url.origin !== self.location.origin) return;
  // l'API doit toujours passer par le réseau (jamais servie depuis le cache)
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response(
      JSON.stringify({ ok: false, offline: true }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    )));
    return;
  }
  // coquille : RÉSEAU d'abord (met à jour le cache), CACHE en secours hors-ligne.
  // CRUCIAL : on force { cache: "reload" } pour CONTOURNER le cache HTTP du
  // navigateur (GitHub Pages envoie un Cache-Control: max-age). Sans ça, après une
  // mise à jour + rechargement, le navigateur resservait un app.js PÉRIMÉ depuis
  // son cache HTTP → la bannière « nouvelle version » réapparaissait indéfiniment,
  // et seul un Ctrl+Shift+R (qui contourne ce cache) la faisait disparaître.
  // « reload » = toujours aller au réseau ET rafraîchir le cache HTTP au passage.
  const fresh = new Request(e.request.url, {
    cache: "reload", headers: e.request.headers, redirect: "follow",
  });
  e.respondWith(
    fetch(fresh).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
