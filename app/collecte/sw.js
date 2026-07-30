// Service worker — mode hors-ligne + RAPIDITÉ de l'app de collecte.
// Stratégie : CACHE D'ABORD pour la coquille (chargement INSTANTANÉ pour un
// visiteur qui revient : zéro aller-retour réseau sur les fichiers déjà en
// cache), l'API toujours au réseau, et `version.json` toujours au réseau (c'est
// LUI qui détecte une nouvelle version → bannière). La fraîcheur est garantie
// par le cycle de vie du SW : chaque release bumpe CACHE → nouvelle installation
// qui PRÉCACHE la coquille FRAÎCHE (`cache: "reload"`, contourne le cache HTTP de
// GitHub Pages), et le bouton « Mettre à jour » purge les caches avant de
// recharger. Aucun fichier périmé ne peut donc survivre à une mise à jour.
const CACHE = "collecte-nge-v460";
// Cache des MÉDIAS (icons/), SÉPARÉ du cache de code (économie de données mobiles, 2026-07-25) :
// bumpé UNIQUEMENT si ce mécanisme lui-même change, JAMAIS à chaque APP_VERSION. Un déploiement
// de code pur (CACHE qui change) ne re-télécharge donc plus AUCUNE image déjà en cache — seul
// un fichier dont le HASH a vraiment changé (icons/manifest.json, généré au build) est reposé.
const MEDIA_CACHE = "collecte-media-v1";
const MANIFEST_URL = "./icons/manifest.json";
const MANIFEST_KEY = self.location.origin + "/__media_manifest_sync__";
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
  "./build/thanks.js",
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
  // Les icônes/médias (icons/*, icons/ui/*) ne sont PLUS précachées ici : elles vivent dans
  // MEDIA_CACHE, synchronisées via icons/manifest.json (syncMediaCache, ci-dessous) — un hash
  // par fichier, jamais purgé par un simple bump de CACHE (code).
  "./flyer/qr.png",
  "./build/keyboard/ngiemboon-keyboard.js",
  "./keyboard/ngiemboon-keyboard.min.css",
  "./build/keyboard/alphabet.data.js",
  "./build/keyboard/alphabets_afrique.js",
];

/** Synchronise MEDIA_CACHE avec icons/manifest.json (hash par fichier, généré au build) : ne
 * télécharge QUE ce qui a réellement changé (fichier absent du cache, ou hash différent).
 * Jamais bloquant pour l'installation (tolère un manifeste absent/réseau coupé). */
async function syncMediaCache() {
  let manifest = null;
  try {
    const res = await fetch(new Request(MANIFEST_URL, { cache: "reload" }));
    if (res && res.ok) manifest = await res.json();
  } catch (e) { return; }   // pas de réseau/manifeste : on garde ce qui est déjà en cache
  if (!manifest) return;
  const c = await caches.open(MEDIA_CACHE);
  let prev = {};
  try {
    const prevRes = await c.match(MANIFEST_KEY);
    if (prevRes) prev = await prevRes.json();
  } catch (e) { prev = {}; }
  const jobs = [];
  for (const path in manifest) {
    if (prev[path] === manifest[path] && (await c.match("./icons/" + path))) continue;   // inchangé : rien à faire
    jobs.push(
      fetch(new Request("./icons/" + path, { cache: "reload" }))
        .then((r) => { if (r && r.ok) return c.put("./icons/" + path, r); })
        .catch(() => {})
    );
  }
  await Promise.allSettled(jobs);
  await c.put(MANIFEST_KEY, new Response(JSON.stringify(manifest)));
}

self.addEventListener("install", (e) => {
  // Précache la coquille FRAÎCHE (cache: "reload" → contourne le cache HTTP, indispensable sur
  // GitHub Pages). Tolérant : un asset manquant n'empêche pas l'installation (allSettled). En
  // parallèle : synchronise les médias (hash par fichier, ne re-télécharge que ce qui a changé).
  e.waitUntil(
    Promise.all([
      caches.open(CACHE).then((c) => Promise.allSettled(
        SHELL.map((u) => fetch(new Request(u, { cache: "reload" })).then((r) => { if (r && r.ok) return c.put(u, r); }))
      )),
      syncMediaCache(),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  // MEDIA_CACHE est délibérément PRÉSERVÉ ici (pas dans la liste des caches à garder par nom
  // exact, mais par PRÉFIXE "collecte-media-" — si son propre schéma de version change un jour,
  // l'ancienne génération de médias est purgée proprement) : un déploiement de CODE (bump de
  // CACHE) ne doit jamais effacer des images déjà téléchargées et toujours à jour.
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== MEDIA_CACHE).map((k) => caches.delete(k)))
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
  // version.json / manifest des médias : TOUJOURS au réseau (ce sont les signaux de fraîcheur —
  // détection de nouvelle version pour l'un, hash par fichier pour l'autre). Cache en secours
  // hors-ligne uniquement, jamais servi depuis le cache quand on est en ligne.
  if (url.pathname.endsWith("/version.json") || url.pathname.endsWith("/icons/manifest.json")) {
    e.respondWith(
      fetch(new Request(e.request.url, { cache: "reload" })).catch(() => caches.match(e.request))
    );
    return;
  }
  // Médias (icons/*) : cache D'ABORD dans MEDIA_CACHE, SÉPARÉ de la coquille (économie de
  // données, cf. syncMediaCache) — jamais purgé par un simple bump de code. Sur cache-miss
  // (image pas encore synchronisée, ou syncMediaCache pas encore passée), on va au réseau et on
  // range le résultat au bon endroit, comme pour la coquille.
  if (url.pathname.indexOf("/icons/") >= 0) {
    e.respondWith(
      caches.open(MEDIA_CACHE).then((c) => c.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(new Request(e.request.url, { cache: "reload", headers: e.request.headers, redirect: "follow" }))
          .then((res) => { if (res && res.ok && !url.search) { const copy = res.clone(); c.put(e.request, copy).catch(() => {}); } return res; })
          .catch(() => c.match(e.request));
      }))
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
