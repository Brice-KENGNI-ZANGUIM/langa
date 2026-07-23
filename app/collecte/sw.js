// Service worker — mode hors-ligne + RAPIDITÉ de l'app de collecte.
// Stratégie : CACHE D'ABORD pour la coquille (chargement INSTANTANÉ pour un
// visiteur qui revient : zéro aller-retour réseau sur les fichiers déjà en
// cache), l'API toujours au réseau, et `version.json` toujours au réseau (c'est
// LUI qui détecte une nouvelle version → bannière). La fraîcheur est garantie
// par le cycle de vie du SW : chaque release bumpe CACHE → nouvelle installation
// qui PRÉCACHE la coquille FRAÎCHE (`cache: "reload"`, contourne le cache HTTP de
// GitHub Pages), et le bouton « Mettre à jour » purge les caches avant de
// recharger. Aucun fichier périmé ne peut donc survivre à une mise à jour.
const CACHE = "collecte-nge-v361";
const SHELL = [
  "./",
  "./index.html",
  // CSS minifié (même dossier que la source → url() d'images inchangés)
  "./fonts.min.css",
  "./app.min.css",
  // JS minifié servi depuis build/ (miroir de la source, imports préservés)
  "./build/app.js",
  "./build/db.js",
  "./build/sync.js",
  "./build/config.js",
  "./build/languages.js",
  "./build/langpacks.js",
  "./build/export.js",
  "./build/share.js",
  "./build/sharecopy.js",
  "./build/langsim.js",
  "./build/langmerge.js",
  "./build/amorce.js",
  "./build/predict.js",
  "./build/lexique.data.js",
  "./build/audioplayer.js",
  "./build/i18n.js",
  "./build/source_en.js",
  "./build/audiotrim.js",
  "./build/legal.js",
  "./build/propositions.js",
  "./build/bugs.js",
  "./version.json",
  "./manifest.webmanifest",
  "./icons/logo.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/bg-pattern-dark.jpg",
  "./icons/bg-pattern-light.jpg",
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
  "./build/keyboard/ngiemboon-keyboard.js",
  "./keyboard/ngiemboon-keyboard.min.css",
  "./build/keyboard/alphabet.data.js",
  "./build/keyboard/alphabets_afrique.js",
];

self.addEventListener("install", (e) => {
  // Précache la coquille FRAÎCHE (cache: "reload" → contourne le cache HTTP, indispensable sur
  // GitHub Pages). Tolérant : un asset manquant n'empêche pas l'installation (allSettled).
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(
      SHELL.map((u) => fetch(new Request(u, { cache: "reload" })).then((r) => { if (r && r.ok) return c.put(u, r); }))
    )).then(() => self.skipWaiting())
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
  // version.json : TOUJOURS au réseau (c'est le signal de détection d'une nouvelle version).
  // Cache en secours hors-ligne uniquement. Jamais servi depuis le cache quand on est en ligne.
  if (url.pathname.endsWith("/version.json")) {
    e.respondWith(
      fetch(new Request(e.request.url, { cache: "reload" })).catch(() => caches.match(e.request))
    );
    return;
  }
  // Coquille : CACHE D'ABORD → réponse INSTANTANÉE si le fichier est déjà en cache (aucun
  // aller-retour réseau). Sur cache-miss (1re visite, ou après purge lors d'une mise à jour),
  // on va au réseau en { cache: "reload" } (contourne le cache HTTP de GitHub Pages, sinon un
  // app.js PÉRIMÉ pouvait resurgir) puis on met en cache. La fraîcheur entre versions est
  // assurée par le bump de CACHE (réinstallation) + la purge des caches au clic « Mettre à jour ».
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(new Request(e.request.url, { cache: "reload", headers: e.request.headers, redirect: "follow" }))
        .then((res) => {
          // On ne met en cache QUE les vraies ressources de la coquille (sans query). Les sondes
          // à cache-buster (`sw.js?ts=…`, `version.json?ts=…`, appelées en boucle par la détection
          // de version) NE sont PAS mises en cache → aucune accumulation d'entrées jetables.
          if (res && res.ok && !url.search) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); }
          return res;
        })
        .catch(() => caches.match(e.request));
    })
  );
});
