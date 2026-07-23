// Application de collecte Nguiemboo — logique principale.
import { NgiemboonKeyboard } from "./keyboard/ngiemboon-keyboard.js";
import { Predict } from "./predict.js";
// audioplayer.js (25 Ko) chargé À LA DEMANDE (uniquement quand un lecteur audio est monté).
let _mountAudioPlayerFn = null;
function mountAudioPlayer(box, audio) {
  if (_mountAudioPlayerFn) { _mountAudioPlayerFn(box, audio); return; }
  import("./audioplayer.js").then((m) => { _mountAudioPlayerFn = m.mountAudioPlayer; _mountAudioPlayerFn(box, audio); }).catch(() => {});
}
import { sliceSamples, encodeWavBytes, detectSilenceBounds, samplesDuration } from "./audiotrim.js";
// source_en.js (157 Ko : équivalents FR→EN) chargé À LA DEMANDE, UNIQUEMENT en interface
// anglaise. Poids mort au boot pour un utilisateur FR (le cas par défaut) : on l'exclut du
// chemin critique. `sourceEn` renvoie null tant que le module n'est pas chargé (repli propre).
let _sourceEnFn = null, _sourceEnPromise = null;
function ensureSourceEn() {
  if (_sourceEnFn) return Promise.resolve(_sourceEnFn);
  if (!_sourceEnPromise) _sourceEnPromise = import("./source_en.js").then((m) => { _sourceEnFn = m.sourceEn; return _sourceEnFn; });
  return _sourceEnPromise;
}
function sourceEn(fr) { return _sourceEnFn ? _sourceEnFn(fr) : null; }
import { DB } from "./db.js";
import { reconcile, checkServer, serverStats, modeGoogle, browseLibrary,
  fetchSuggestions, postSuggestion, postVote, postBug, fetchBugs,
  fetchLanguages, declareLanguage, declareUser, fetchMyContributions, fetchDriveAudio,
  proposeMerge, respondMerge, mergesForDevice, fetchNotifications,
  fetchRequests, fetchRequestsToTranslate, postRequest, postAnswer, translateWord,
  submitTestimonial, fetchTestimonials, updateContribution } from "./sync.js";
// PROPOSITIONS (1,37 Mo, dont ~68k mots de dictionnaire) n'est utilisé QUE dans le flux
// Traduire/Transcrire (et l'incitation), jamais pour le rendu de l'accueil. On l'importe
// DYNAMIQUEMENT → son parse ne bloque plus le premier rendu (démarrage nettement plus rapide,
// surtout sur mobile). Il est préchargé en arrière-plan juste après l'affichage de l'accueil.
// Planifie un travail non critique pour le moment où le navigateur est VRAIMENT inactif
// (adaptatif au device, ne dispute pas le fil principal au rendu en cours), avec un filet de
// sécurité (timeout) pour ne jamais reporter indéfiniment sur un appareil chargé. Repli sur
// setTimeout si l'API n'existe pas (anciens navigateurs). Réutilisé partout où un délai fixe
// (ex. setTimeout(…, 700)) devinait un instant plutôt que de le mesurer.
function idleInit(cb, timeoutMs) {
  if (window.requestIdleCallback) window.requestIdleCallback(cb, { timeout: timeoutMs || 1200 });
  else setTimeout(cb, 1);
}
let PROPOSITIONS = null;
let _propsPromise = null;
function ensurePropositions() {
  if (PROPOSITIONS) return Promise.resolve(PROPOSITIONS);
  if (!_propsPromise) _propsPromise = import("./propositions.js").then((m) => { PROPOSITIONS = m.PROPOSITIONS; return PROPOSITIONS; });
  return _propsPromise;
}
// bugs.js (journal versionné) chargé à la demande, uniquement à l'ouverture de la vue Bugs.
import { CONFIG } from "./config.js";
import { currentLang, getCurrentLangId, setCurrentLangId, usesDedicatedKeyboard,
  hasChosenLang, knownLanguages, cacheRemoteLanguages, langAlphabet, langLexicon, addKnownLanguage } from "./languages.js";
import { applyI18n, getUiLang, setUiLang, t, tToast } from "./i18n.js";
// legal.js (textes légaux) et export.js (formats d'export) : chargés à la demande, uniquement
// à l'ouverture de la vue légale / au clic d'export (voir openLegal / downloadDict).
import { shareCardText, shareTitle, mountShareBar } from "./share.js";
import { shareMessage, shareSubject } from "./sharecopy.js";
import { findSimilarLanguages } from "./langsim.js";
import { findDuplicatePairs, pickCanonical, resolveCanonicalId, visibleLanguages } from "./langmerge.js";
import { AMORCE, AMORCE_MIN } from "./amorce.js";

const $ = (sel) => document.querySelector(sel);
const nfc = (s) => (s || "").normalize("NFC");

// Version affichée dans l'en-tête : permet de vérifier d'un coup d'œil que le
// téléphone charge bien la DERNIÈRE version (et non une copie en cache). À garder
// synchrone avec CACHE dans sw.js.
const APP_VERSION = "v360";
// Espace courant : "translate" (Traduire) ou "transcribe" (Transcrire).
let activity = "translate";
// Vue affichée (pour la visite guidée contextuelle). Défaut NEUTRE (null) : au boot,
// aucune vue n'est encore rendue, donc le garde d'idempotence de routeTo() ne doit pas
// court-circuiter la 1re route (bug : défaut « profile » vidait #/profil après rechargement,
// notamment à la bascule de langue). showView() renseigne la vraie vue dès le 1er rendu.
let _currentView = null;
let _aboutReturn = "hub"; // vue vers laquelle « ← Retour » ramène depuis À propos

// --- Identité de l'appareil (persistante) --------------------------------
function deviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || "dev-" + Date.now();
    localStorage.setItem("deviceId", id);
  }
  return id;
}
// ── JETON DE PROPRIÉTÉ (Couche 2) ───────────────────────────────────────────
// Secret LOCAL, jamais envoyé en clair au moment du profil : on n'envoie que son
// HASH (SHA-256). Il prouve, au moment d'une correction (Couche 3), que l'appareil
// est bien le propriétaire de la contribution, même si un tiers connaissait le
// device_id. Créé à la volée (donc RÉTROACTIF : les profils existants en obtiennent
// un à la prochaine remontée de profil).
function ownerToken() {
  let t = localStorage.getItem("langa-owner");
  if (!t) {
    t = (crypto.randomUUID && crypto.randomUUID()) ||
        ("own-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    localStorage.setItem("langa-owner", t);
  }
  return t;
}
/** Hash hex du jeton (SHA-256 via Web Crypto ; repli déterministe hors contexte sécurisé). */
async function ownerHash() {
  const tok = ownerToken();
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    let h = 0; for (let i = 0; i < tok.length; i++) { h = (h * 31 + tok.charCodeAt(i)) | 0; }
    return "w" + (h >>> 0).toString(16);
  }
}

// --- IDENTITÉ D'APPAREIL : paire de clés cryptographique persistante ----------
// Sans compte ni mot de passe. À la 1re connexion, on génère une paire de clés (ECDSA
// P-256) ; la clé PRIVÉE reste dans IndexedDB de l'appareil (à jamais), la clé PUBLIQUE
// est exportée (base64) et envoyée avec le profil → chaque appareil est reconnu de façon
// unique et infalsifiable. IndexedDB dédiée « langa-identity » (n'affecte pas la base des
// contributions). Repli silencieux si Web Crypto indisponible (le device_id reste).
let _devPubB64 = null;
function _openKeyDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("langa-identity", 1);
    r.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys"); };
    r.onsuccess = (e) => res(e.target.result);
    r.onerror = () => rej(r.error);
  });
}
function _idbGet(db, k) { return new Promise((res) => { const t = db.transaction("keys", "readonly").objectStore("keys").get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(null); }); }
function _idbPut(db, k, v) { return new Promise((res) => { const t = db.transaction("keys", "readwrite").objectStore("keys").put(v, k); t.onsuccess = () => res(true); t.onerror = () => res(false); }); }
function _abToB64(buf) { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
/** Assure la paire de clés d'appareil ; renvoie la clé PUBLIQUE (base64 SPKI) ou "". */
async function ensureDeviceKey() {
  if (_devPubB64) return _devPubB64;
  try {
    const db = await _openKeyDB();
    let pair = await _idbGet(db, "keypair");
    if (!pair || !pair.publicKey) {
      pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      await _idbPut(db, "keypair", pair);   // persiste la CryptoKey sur l'appareil
    }
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    _devPubB64 = _abToB64(spki);
    return _devPubB64;
  } catch (e) { return ""; }
}

// --- Contributeur (persisté en localStorage) -----------------------------
function loadContributeur() {
  try {
    return JSON.parse(localStorage.getItem("contributeur") || "{}");
  } catch (e) {
    return {};
  }
}
function saveContributeur(c) {
  localStorage.setItem("contributeur", JSON.stringify(c));
}
/** Ajoute une langue à l'ensemble des langues d'APPARTENANCE du profil (sans doublon).
    La 1re de la liste fait office de langue principale. */
function addProfileLangue(id) {
  if (!id) return;
  const c = loadContributeur();
  const set = Array.isArray(c.langues) ? c.langues.slice() : [];
  if (!set.includes(id)) set.push(id);
  c.langues = set;
  saveContributeur(c);
}
/** Langues d'appartenance du profil (au moins la langue courante par défaut). */
function profileLangues() {
  const c = loadContributeur();
  return Array.isArray(c.langues) ? c.langues.slice() : [];
}
/** Ajoute / promeut / retire une langue d'appartenance (clic sur une puce du profil) :
    - langue absente  → ajoutée (en fin) ;
    - déjà présente et NON principale → promue principale (passe en tête) ;
    - déjà présente et PRINCIPALE → retirée (la suivante devient principale). */
function toggleProfileLang(id) {
  const c = loadContributeur();
  let mine = Array.isArray(c.langues) ? c.langues.slice() : [];
  if (!mine.includes(id)) mine.push(id);
  else if (mine[0] === id) mine = mine.filter((x) => x !== id);
  else mine = [id, ...mine.filter((x) => x !== id)];
  c.langues = mine;
  saveContributeur(c);
  renderProfileLangs();
}
/** Peint les puces des langues d'appartenance dans le formulaire de profil. */
function renderProfileLangs() {
  const box = $("#profile-langs");
  if (!box) return;
  const mine = profileLangues();
  const langs = knownLanguages();
  box.innerHTML = langs.map((l) => {
    const on = mine.includes(l.id);
    const primary = mine[0] === l.id;
    return `<button type="button" class="lang-chip-toggle${on ? " is-on" : ""}${primary ? " is-primary" : ""}" data-lang="${escapeHtml(l.id)}" aria-pressed="${on}">
      <span class="lct-name">${escapeHtml(l.nom)}</span>${primary ? `<span class="lct-primary">${t("p.langs.primary")}</span>` : ""}</button>`;
  }).join("") +
    `<button type="button" class="lang-chip-toggle lang-chip-add" id="profile-lang-add">➕ <span class="lct-name">${t("lang.add")}</span></button>`;
  box.querySelectorAll(".lang-chip-toggle[data-lang]").forEach((btn) =>
    btn.addEventListener("click", () => toggleProfileLang(btn.dataset.lang)));
  const add = $("#profile-lang-add");
  // Déclarer une nouvelle langue SANS quitter le profil : le formulaire unique s'ouvre en place.
  if (add) add.addEventListener("click", openDeclareInProfile);
}

// --- État ----------------------------------------------------------------
let direction = "fr2nge"; // fr2nge | nge2fr
let mode = "proposer";    // proposer | libre  (défaut : proposer)
let propCat = "auto";     // "auto" = progression ordonnée ; sinon un groupe précis
let currentProp = null;   // proposition en cours {id, cat, texte}
let _currentReqId = null; // lot 5 : id de la DEMANDE en cours de réponse (source venue du bandeau)
let keyboard = null;
let predict = null;
// Caractères d'un « mot » ngiemboon (lettres Unicode + coup de glotte + tons combinants).
const PRED_WORD = "[\\p{L}ʼ'’̀-ͯ]";
const PRED_BEFORE = new RegExp(PRED_WORD + "+$", "u");
const PRED_AFTER = new RegExp("^" + PRED_WORD + "+", "u");
let mediaRecorder = null;
let recTimer = null;
let audioChunks = [];
let audioBlob = null;
let audioStartTs = 0;
let audioDurationMs = 0;
let _recDiscard = false;   // true → l'enregistrement en cours doit être JETÉ (pas gardé)

// Interpolation d'une chaîne i18n : ti("dir.src.lang", {lang}) → remplace {lang} etc.
function ti(key, subs) {
  let s = t(key);
  if (subs) for (const k in subs) s = s.split("{" + k + "}").join(subs[k]);
  return s;
}

// --- Sens de traduction : quel champ est en ngiemboon --------------------
function ngeField() {
  return direction === "fr2nge" ? $("#target") : $("#source");
}
function applyDirection() {
  const fr2nge = direction === "fr2nge";
  const L = currentLang();
  const dedicated = usesDedicatedKeyboard(L.id);   // clavier dédié (nge) vs clavier système
  $("#lbl-source").textContent = fr2nge ? t("dir.src.fr") : ti("dir.src.lang", { lang: L.nom });
  $("#lbl-target").textContent = fr2nge ? ti("dir.tgt.lang", { lang: L.nom }) : t("dir.tgt.fr");
  $("#source").dir = "ltr";
  // badge langue sur chaque champ (libellé complet)
  const FR = t("dir.badge.fr");
  const TGT = `${L.nom} (${L.id.slice(0, 3).toUpperCase()})`;
  $("#tag-source").textContent = fr2nge ? FR : TGT;
  $("#tag-target").textContent = fr2nge ? TGT : FR;
  // L'audio se prononce TOUJOURS dans la langue collectée (jamais en français) → son
  // étiquette suit la langue courante, quel que soit le sens.
  const ta = $("#tag-audio"); if (ta) ta.textContent = TGT;
  const nge = ngeField();
  const block = $("#kb-block");
  if (dedicated) {
    // Langue à clavier DÉDIÉ (ngiemboon) : clavier à l'écran, OS supprimé.
    if (block) block.hidden = false;
    if (keyboard) keyboard.setTarget(nge);   // insère dans ce champ + inputmode=none
    $("#kb-host-label").textContent = ti(fr2nge ? "kb.host.tgt" : "kb.host.src", { lang: L.nom });
    const anchor = fr2nge ? $("#target-wrap") : $("#source-wrap");
    if (block) anchor.appendChild(block);
    bindKeyboardReveal();   // relie l'ouverture au nouveau champ de la langue
  } else {
    // Langue à clavier PAR DÉFAUT (système) : on masque le clavier maison et on
    // rend la main au clavier de l'appareil (pas d'inputmode=none).
    if (block) block.hidden = true;
    hideKeyboard();
    if (nge) nge.removeAttribute("inputmode");
    if (_kbField) { _kbField.removeEventListener("pointerdown", onFieldPointerDown); _kbField = null; }
  }
  $$directionButtons();
}
/** Applique la LANGUE courante à toute l'UI (libellés dépendant de la langue) puis
    rafraîchit le sens de traduction. À appeler au démarrage et à chaque changement
    de langue. */
function applyLanguage() {
  const L = currentLang();
  const dFr2 = ti("dir.fr2lang", { lang: L.nom }), dLang2 = ti("dir.lang2fr", { lang: L.nom });
  const b1 = $("#dir-fr2nge"); if (b1) b1.textContent = dFr2;
  const b2 = $("#dir-nge2fr"); if (b2) b2.textContent = dLang2;
  const o1 = document.querySelector('#filter-direction option[value="fr2nge"]'); if (o1) o1.textContent = dFr2;
  const o2 = document.querySelector('#filter-direction option[value="nge2fr"]'); if (o2) o2.textContent = dLang2;
  const dT = document.querySelector('.hub-card[data-go="translate"] .hub-desc');
  if (dT) dT.textContent = t("hub.desc.translate").replace("{lang}", L.nom);
  const dS = document.querySelector('.hub-card[data-go="transcribe"] .hub-desc');
  if (dS) dS.textContent = t("hub.desc.transcribe").replace("{lang}", L.nom);
  const dE = document.querySelector('.hub-card[data-go="explore"] .hub-desc');
  if (dE) dE.textContent = t("hub.card.explore.desc");
  const chipName = $("#lang-chip-name"); if (chipName) chipName.textContent = hasChosenLang() ? L.nom : t("chip.langues");
  updateWorkLang();
  applyDirection();
}

// --- Couche 1 anti-mauvais étiquetage : langue de contribution rendue explicite -------
// L'indicateur FORT (#work-lang) rappelle en permanence dans quelle langue on contribue, et
// une confirmation apparaît à l'enregistrement tant que la langue n'a pas été validée cette
// session (ou si l'écriture du texte contredit la langue choisie). Empêche d'inscrire une
// contribution dans la mauvaise langue cible (bug « je transcris en X, la base note Y »).
let _langAck = null;   // langue explicitement confirmée par l'utilisateur pour cette session
function updateWorkLang() {
  const el = $("#work-lang"); if (!el) return;
  if (!el.dataset.bound) { el.dataset.bound = "1"; el.addEventListener("click", () => openLangChoice()); }
  const lid = getCurrentLangId();
  const name = _langNameById(lid) || "—";
  const nm = $("#work-lang-name"); if (nm) nm.textContent = name;
  el.setAttribute("aria-label", ti("work.lang.aria", { lang: name }));
  el.classList.toggle("is-unconfirmed", _langAck !== lid);   // teinte d'alerte tant que non confirmée
}
/** Confirmation bloquante de la langue (Promise → true si confirmée, false si « changer »). */
function confirmLang(lid, doubt) {
  return new Promise((resolve) => {
    const m = $("#lang-confirm"); if (!m) { resolve(true); return; }
    const name = _langNameById(lid) || String(lid || "");
    const msg = $("#lc-msg"); if (msg) msg.textContent = ti("langconfirm.msg", { lang: name });
    const dEl = $("#lc-doubt");
    if (dEl) { if (doubt) { dEl.textContent = ti("langconfirm.doubt", { lang: name }); dEl.hidden = false; } else { dEl.hidden = true; } }
    const ok = $("#lc-ok"), ch = $("#lc-change");
    if (ok) ok.textContent = ti("langconfirm.ok", { lang: name });
    if (ch) ch.textContent = t("langconfirm.change");
    m.hidden = false;
    try { ok.focus(); } catch (e) { /* ok */ }
    const done = (v) => { m.hidden = true; if (ok) ok.onclick = null; if (ch) ch.onclick = null; resolve(v); };
    if (ok) ok.onclick = () => done(true);
    if (ch) ch.onclick = () => done(false);
  });
}
// Clic sur l'indicateur → écran de choix de langue (changer de langue de contribution).
document.addEventListener("DOMContentLoaded", () => {
  const wl = $("#work-lang"); if (wl) wl.addEventListener("click", () => openLangChoice());
});
// --- Mode « proposer un mot » -------------------------------------------
// --- Anti-répétition PAR UTILISATEUR (device) : un item déjà traité (traduit OU
//     transcrit) par CET utilisateur ne lui est plus proposé. Dédup par TEXTE
//     normalisé (et non par id : le même mot existe avec plusieurs ids —
//     ex. « eau » dans « mots » ET dans le dictionnaire — ce qui le faisait
//     revenir). L'ensemble « déjà fait » est reconstruit depuis les
//     CONTRIBUTIONS RÉELLES (IndexedDB) + un cache localStorage (effet immédiat,
//     survit à un vidage de la base locale). N'affecte que cet utilisateur.
function normTxt(s) {
  return (s || "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}
let _doneTexts = new Set();
async function refreshDoneTexts() {
  const set = new Set();
  try { JSON.parse(localStorage.getItem("propFaitesTxt") || "[]").forEach((t) => set.add(t)); } catch (e) {}
  try {
    for (const r of await DB.all()) {
      // Les items proposés sont en français (mode proposer = FR→NGE) : la source
      // est l'item traité. Toute contribution du user sur cet item le « clôt ».
      if (r.source_text) set.add(normTxt(r.source_text));
    }
  } catch (e) { /* base indispo : on garde au moins le cache localStorage */ }
  _doneTexts = set;
}
function markDoneText(txt) {
  const n = normTxt(txt); if (!n) return;
  _doneTexts.add(n);
  try {
    const arr = JSON.parse(localStorage.getItem("propFaitesTxt") || "[]");
    if (!arr.includes(n)) { arr.push(n); localStorage.setItem("propFaitesTxt", JSON.stringify(arr)); }
  } catch (e) { /* stockage indispo */ }
}
let ALL_PROPS = null;
function allProps() {
  if (!PROPOSITIONS) return [];   // pas encore chargé (import dynamique) → vide, sans crasher
  if (!ALL_PROPS) {
    const base = 1000000; // ids synthétiques pour les mots du dictionnaire
    const dico = (PROPOSITIONS.dictionnaire || []).map((t, i) =>
      ({ id: base + i, cat: "dictionnaire", texte: t }));
    // norm précalculé UNE fois (évite de re-normaliser ~71k textes à chaque proposition)
    ALL_PROPS = PROPOSITIONS.items.concat(dico).map((it) => ({ ...it, norm: normTxt(it.texte) }));
  }
  return ALL_PROPS;
}
// --- Progression ORDONNÉE des groupes -------------------------------------
// Ordre d'épuisement ; le DICTIONNAIRE est TOUJOURS en dernier (long, et
// contient des mots parfois inexistants/difficiles dans la langue). Le moteur
// propose toujours le PREMIER groupe non épuisé → épuisement progressif, et
// RETOUR automatique à un groupe antérieur qui vient d'être enrichi.
// Ordre EXACT demandé par Brice : MOTS d'abord, puis PHRASES, puis le reste
// (lettres, chiffres, nombres), et le DICTIONNAIRE TOUJOURS EN DERNIER.
const GROUP_ORDER = ["mots", "phrases", "conjugaison", "pronoms", "prepositions", "pluriels", "lettres", "chiffres", "nombres", "dictionnaire"];
let _BY_CAT = null;
function byCat() {
  if (!PROPOSITIONS) return {};   // pas encore chargé → NE PAS mettre en cache un résultat vide
  if (!_BY_CAT) {
    _BY_CAT = {};
    for (const it of allProps()) { (_BY_CAT[it.cat] = _BY_CAT[it.cat] || []).push(it); }
  }
  return _BY_CAT;
}
function groupItems(key) { return byCat()[key] || []; }
function groupUndone(key) {
  return groupItems(key).filter((it) => !_doneTexts.has(it.norm || normTxt(it.texte)));
}
function groupLabel(key) {
  const k = "grp." + key;
  const s = t(k);
  if (s !== k) return s;                        // libellé i18n connu (FR/EN)
  const c = ((PROPOSITIONS && PROPOSITIONS.categories) || []).find((x) => x.key === key);
  return c ? c.label : key;
}
/** Premier groupe (dans l'ORDRE) ayant encore des items non faits par l'user. */
function firstUndoneGroup() {
  for (const k of GROUP_ORDER) { if (groupUndone(k).length > 0) return k; }
  return null;
}
function _shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t2 = a[i]; a[i] = a[j]; a[j] = t2; } return a; }
// MOTEUR CYCLIQUE (Brice) : en mode AUTO, on ne vide plus un groupe avant le suivant.
// On propose UN item par groupe en TOURNANT de groupe en groupe ; l'ORDRE des groupes est
// RE-MÉLANGÉ à chaque cycle, et l'item dans un groupe est tiré au hasard (cf. loadProposition).
// Le DICTIONNAIRE (68k mots rares) reste HORS cycle : dernier recours quand les groupes curés
// sont épuisés (sinon il diluerait la matière curée avec des mots rares/difficiles).
let _cycleQueue = [];
function _autoGroup() {
  const curated = GROUP_ORDER.filter((k) => k !== "dictionnaire" && groupUndone(k).length > 0);
  if (curated.length) {
    _cycleQueue = _cycleQueue.filter((k) => k !== "dictionnaire" && groupUndone(k).length > 0);   // purge les épuisés
    if (!_cycleQueue.length) {
      _cycleQueue = _shuffle(curated.slice());   // nouveau cycle = nouvel ordre aléatoire
      // évite que le même groupe se rejoue à la frontière de deux cycles (fin du précédent = début du suivant)
      if (curated.length > 1 && _cycleQueue[0] === _lastGroup) _cycleQueue.push(_cycleQueue.shift());
    }
    return _cycleQueue.shift();
  }
  return groupUndone("dictionnaire").length > 0 ? "dictionnaire" : null;   // recours final
}
/** Groupe actif : choix manuel s'il reste des items ; sinon rotation cyclique aléatoire. */
function resolveGroup() {
  if (propCat && propCat !== "auto" && groupUndone(propCat).length > 0) return propCat;
  return _autoGroup();
}
function initPropCategories() {
  const sel = $("#prop-cat");
  const cats = (PROPOSITIONS && PROPOSITIONS.categories) || [];
  const opts = [`<option value="auto">${t("prop.auto")}</option>`].concat(
    cats.map((c) => `<option value="${c.key}">${groupLabel(c.key)} (${c.n})</option>`)
  );
  sel.innerHTML = opts.join("");
  sel.value = propCat;
}
/** Jette le travail en cours NON enregistré (texte cible, note, domaine, et un
    audio enregistré mais pas sauvegardé) — appelé à chaque passage au mot suivant
    pour qu'une transcription abandonnée ne « colle » pas au mot d'après. */
function discardWorkingInputs() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    _recDiscard = true;
    try { mediaRecorder.stop(); } catch (e) { /* ok */ }
    stopRecording();
  }
  clearAudio();
  ["#target", "#note", "#domaine"].forEach((s) => { const el = $(s); if (el) el.value = ""; });
  resetWordEnrich();
}
// R4 : liste des champs d'enrichissement du mot (tous facultatifs).
const WORD_ENRICH_FIELDS = {
  nature: "#we-nature", classe_nominale: "#we-classe", genre: "#we-genre", nombre: "#we-nombre",
  pluriel: "#we-pluriel", prononciation: "#we-prononciation", registre: "#we-registre",
  etymologie: "#we-etymologie", exemple: "#we-exemple", exemple_trad: "#we-exemple-trad",
  synonymes: "#we-synonymes", antonymes: "#we-antonymes",
};
/** Rassemble les champs d'enrichissement NON VIDES en un objet structuré (ou null). */
function collectWordMeta() {
  const m = {};
  for (const k in WORD_ENRICH_FIELDS) {
    const el = $(WORD_ENRICH_FIELDS[k]);
    const v = el ? String(el.value || "").trim() : "";
    if (v) m[k] = v;
  }
  return Object.keys(m).length ? m : null;
}
/** Réinitialise + replie la section d'enrichissement (au mot suivant / après envoi). */
function resetWordEnrich() {
  for (const k in WORD_ENRICH_FIELDS) { const el = $(WORD_ENRICH_FIELDS[k]); if (el) el.value = ""; }
  const d = $("#word-enrich"); if (d) d.open = false;
}
/** RÈGLE GLOBALE (Brice) : une action qui RESTE sur la même page (mot suivant, envoi,
    vote, bascule…) ne doit JAMAIS déplacer le défilement, pas d'un pixel. On mémorise
    la position et on la restaure, y compris après un focus/rendu qui tenterait de faire
    défiler. Seule une VRAIE navigation (showView) remonte en haut de page. */
function keepScroll(fn) {
  const x = window.scrollX, y = window.scrollY;
  const restore = () => { if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y); };
  try { if (typeof fn === "function") fn(); } finally {
    restore();
    requestAnimationFrame(restore);
  }
}
let _lastGroup = null;
function loadProposition() {
  _currentReqId = null;     // item du corpus -> on ne répond plus à une demande
  discardWorkingInputs();   // repart propre : rien de l'ancien mot ne subsiste
  // Un groupe manuel épuisé → on repasse en mode automatique.
  if (propCat !== "auto" && groupUndone(propCat).length === 0) {
    propCat = "auto";
    const s = $("#prop-cat"); if (s) { s.value = "auto"; refreshEnhancedSelects(); }
  }
  const group = resolveGroup();
  const verb = activity === "transcribe" ? t("prog.verb.transcribe") : t("prog.verb.translate");
  if (!group) {                       // tous les groupes épuisés
    currentProp = null; _lastGroup = null;
    $("#prop-progress").textContent = "";
    $("#source").value = "";
    $("#source").placeholder = t("wk.done.all");
    return;
  }
  const items = groupItems(group);
  const restants = items.filter((it) => !_doneTexts.has(it.norm || normTxt(it.texte)));
  const total = items.length, faits = total - restants.length;
  // Progression PAR GROUPE (ex. « Mots · 7/335 traduits »), verbe selon l'activité.
  // En mode auto CYCLIQUE le groupe change à chaque proposition : plus d'annonce de
  // « groupe terminé » (elle n'a de sens que dans l'ancien épuisement séquentiel).
  $("#prop-progress").textContent = `${groupLabel(group)} · ${faits} / ${total} ${verb}`;
  _lastGroup = group;
  // Tirage AU HASARD parmi les restants du groupe.
  currentProp = restants[Math.floor(Math.random() * restants.length)];
  const src = $("#source");
  src.dataset.canon = currentProp.texte;            // #48 : on STOCKE le mot canonique (français)…
  src.value = sourceDisplay(currentProp.texte);     // …et on AFFICHE dans la langue d'interface (EN si l'utilisateur y est passé)
  src.dispatchEvent(new Event("input", { bubbles: true }));
  $("#target").value = "";
  // RÈGLE GLOBALE (Brice) : « mot suivant » RESTE sur la même page → le défilement ne
  // doit PAS bouger. On ne fait donc pas défiler vers le champ : focus SANS scroll en
  // Traduire (pour taper directement), aucun focus en Transcrire (le champ voix est plus
  // bas et ferait sauter la vue). keepScroll verrouille la position par sécurité.
  keepScroll(() => {
    if (activity !== "transcribe") { try { $("#target").focus({ preventScroll: true }); } catch (e) { /* ok */ } }
  });
}
/** #48 : texte de l'item source à AFFICHER, dans la langue d'interface. En anglais, on
    montre l'équivalent connu (nombres, lettres, parenté…) ; sinon on garde le français
    (aucune invention). Le mot canonique stocké reste le français, cf. loadProposition. */
function sourceDisplay(fr) {
  if (getUiLang() !== "en") return fr;
  return sourceEn(fr) || _wordEnCache.get(String(fr || "").trim().toLowerCase()) || fr;
}
// Cache de SESSION des équivalents anglais résolus par le backend (base puis DeepL),
// pour ne jamais réafficher un mot français à un anglophone après une 1re résolution.
const _wordEnCache = new Map();   // fr(lower) -> en
/** Mot à AFFICHER dans la langue d'interface. En anglais : équivalent connu (base
    source_en) ou déjà résolu (cache) ; repli = le mot d'origine (jamais d'invention).
    Version SYNCHRONE (pour un rendu immédiat). */
function wordInUiLang(fr) {
  const s = String(fr || "").trim();
  if (getUiLang() !== "en" || !s) return s;
  return sourceEn(s) || _wordEnCache.get(s.toLowerCase()) || s;
}
/** Résout l'équivalent anglais AVANT affichage : base locale d'abord, puis le backend
    (qui cherche en base, sinon DeepL, et MÉMORISE à jamais). Met en cache de session. */
async function resolveWordUi(fr) {
  const s = String(fr || "").trim();
  if (getUiLang() !== "en" || !s) return s;
  await ensureSourceEn();   // garantit la base FR→EN chargée avant résolution (chemin async)
  const known = sourceEn(s); if (known) return known;
  const low = s.toLowerCase();
  if (_wordEnCache.has(low)) return _wordEnCache.get(low);
  try {
    const r = await translateWord(s, "en");
    const en = (r && r.text) ? String(r.text).trim() : "";
    if (en) { _wordEnCache.set(low, en); return en; }
  } catch (e) { /* hors ligne : repli */ }
  return s;
}
function applyMode() {
  const proposer = mode === "proposer";
  $("#mode-prop").classList.toggle("is-active", proposer);
  $("#mode-libre").classList.toggle("is-active", !proposer);
  $("#prop-bar").hidden = !proposer;
  // en mode proposer : source = français imposé, non modifiable, sens FR→NGE
  $("#source").readOnly = proposer;
  $("#dir-toggle").hidden = proposer;
  if (proposer && direction !== "fr2nge") { direction = "fr2nge"; applyDirection(); }
  if (proposer) { refreshDoneTexts().then(() => loadProposition()); }
  else { const s = $("#source"); s.value = ""; delete s.dataset.canon; s.placeholder = t("wk.source.ph"); currentProp = null; _currentReqId = null; }
  localStorage.setItem("modeSaisie", mode);
}

function $$directionButtons() {
  $("#dir-fr2nge").classList.toggle("is-active", direction === "fr2nge");
  $("#dir-nge2fr").classList.toggle("is-active", direction === "nge2fr");
}

// --- Audio (MediaRecorder) ----------------------------------------------
/** Obtient un flux micro de façon ROBUSTE : essaie les contraintes par défaut,
    puis — en cas d'échec « périphérique absent / occupé / sur-contraint » —
    énumère les entrées audio et tente CHAQUE périphérique, puis une contrainte
    minimale. Ne relève l'erreur d'origine qu'en tout dernier recours. */
async function acquireMicStream() {
  const md = navigator.mediaDevices;
  try {
    return await md.getUserMedia({ audio: true });
  } catch (e1) {
    // Erreurs où insister a un sens (le refus explicite, lui, ne se force pas).
    const soft = ["NotFoundError", "DevicesNotFoundError", "OverconstrainedError",
      "OverConstrainedError", "NotReadableError", "TrackStartError", "AbortError"];
    if (!soft.includes(e1.name)) throw e1;
    let inputs = [];
    try {
      inputs = (await md.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId);
    } catch (_) { /* enumerateDevices peut échouer tant que la permission n'est pas donnée */ }
    for (const dev of inputs) {
      try { return await md.getUserMedia({ audio: { deviceId: { exact: dev.deviceId } } }); }
      catch (_) { /* périphérique suivant */ }
    }
    try { return await md.getUserMedia({ audio: {} }); } catch (_) { /* contrainte minimale */ }
    throw e1;   // vraiment aucun micro exploitable → on remonte l'erreur d'origine
  }
}
async function startRecording() {
  const rs = $("#rec-state");
  // Le micro exige un contexte SÉCURISÉ (localhost ou HTTPS). Sur http://IP ou
  // file://, le navigateur bloque getUserMedia — cause n°1 des « je n'arrive pas ».
  if (!window.isSecureContext) {
    rs.textContent = t("rec.blocked");
    toast(t("toast.audio.https"), "warn");
    renderMicDiag(micStaticInfo(), "?", false, "insecure");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    rs.textContent = t("rec.unsupported");
    toast(t("toast.audio.unsupported"), "warn");
    renderMicDiag(micStaticInfo(), "?", false, "");
    return;
  }
  try {
    const stream = await acquireMicStream();
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      // Enregistrement ANNULÉ (passage au mot suivant sans l'avoir gardé) : on jette.
      if (_recDiscard) { _recDiscard = false; audioChunks = []; audioBlob = null; audioDurationMs = 0; renderAudio(); return; }
      audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      audioDurationMs = Date.now() - audioStartTs;
      renderAudio();
    };
    audioStartTs = Date.now();
    mediaRecorder.start();
    $("#btn-rec").classList.add("is-recording");
    const sp = $("#btn-rec").querySelector("span"); if (sp) sp.textContent = t("rec.stop");
    rs.textContent = "";
    _lockSaveWhileRecording(true);   // pendant l'enregistrement, « Enregistrer » est grisé (évite la confusion)
    startRecTimer();
  } catch (e) {
    const msg = e.name === "NotAllowedError" || e.name === "SecurityError"
      ? t("mic.err.denied")
      : e.name === "NotReadableError" || e.name === "TrackStartError"
      ? t("mic.err.busy")
      : e.name === "NotFoundError" || e.name === "DevicesNotFoundError"
      ? t("mic.err.none")
      : ti("mic.err.other", { n: e.name });
    rs.textContent = msg;
    toast(msg, "warn");
    testMic();   // diagnostic COMPLET (nb de micros + autorisation navigateur)
  }
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  $("#btn-rec").classList.remove("is-recording");
  const sp = $("#btn-rec").querySelector("span"); if (sp) sp.textContent = t("rec.start");
  $("#rec-state").textContent = "";
  _lockSaveWhileRecording(false);   // enregistrement arrêté → « Enregistrer » redevient actionnable
  stopRecTimer();
}
/** Grise le bouton « Enregistrer la contribution » TANT QUE l'enregistrement n'est pas arrêté :
    on ne peut pas enregistrer une capture encore en cours, et cela lève la confusion entre le
    bouton « Arrêter » (rouge, actif) et « Enregistrer » (qui restaient d'aspect trop proche). */
function _lockSaveWhileRecording(locked) {
  const s = $("#btn-save"); if (!s) return;
  s.disabled = !!locked;
  s.classList.toggle("is-rec-locked", !!locked);
  if (locked) s.title = t("rec.savelocked"); else s.removeAttribute("title");
}
/** Timer d'enregistrement : temps écoulé mis à jour ~4×/s, masqué à l'arrêt. */
function fmtRec(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
function startRecTimer() {
  const el = $("#rec-timer"); if (!el) return;
  el.hidden = false; el.textContent = "00:00";
  clearInterval(recTimer);
  recTimer = setInterval(() => { el.textContent = fmtRec(Date.now() - audioStartTs); }, 250);
}
function stopRecTimer() {
  clearInterval(recTimer); recTimer = null;
  const el = $("#rec-timer"); if (el) { el.hidden = true; el.textContent = "00:00"; }
}

// --- Diagnostic micro (pour localiser PRÉCISÉMENT un blocage, surtout mobile) ---
function isStandalonePWA() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
    || window.navigator.standalone === true;
}
function inAppBrowser() {
  return /(FBAN|FBAV|FB_IAB|Instagram|Line|Twitter|WhatsApp|Snapchat|Pinterest|MicroMessenger|WeChat|TikTok)/i
    .test(navigator.userAgent || "");
}
/** Vrai sur téléphone/tablette (micro intégré), faux sur PC de bureau/portable. */
function isMobileDevice() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone|IEMobile/i.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPadOS se déguise en Mac
}
/** Conseil ciblé selon la cause la plus probable (ordre = du plus bloquant au moins). */
function micAdvice(errName, perm, nbInputs) {
  if (!window.isSecureContext) return t("mic.adv.insecure");
  if (inAppBrowser()) return t("mic.adv.inapp");
  if (!window.MediaRecorder) return t("mic.adv.norecorder");
  if (isStandalonePWA()) return t("mic.adv.pwa");
  if (perm === "denied" || errName === "NotAllowedError" || errName === "SecurityError") return t("mic.adv.denied");
  if (Number(nbInputs) === 0 || errName === "NotFoundError" || errName === "DevicesNotFoundError")
    return isMobileDevice() ? t("mic.adv.none.mobile") : t("mic.adv.none.desktop");
  if (errName === "NotReadableError" || errName === "TrackStartError") return t("mic.adv.busy");
  return t("mic.adv.unknown");
}
function micStaticInfo() {
  const md = navigator.mediaDevices;
  // { clé i18n → {val, inverse} } : `inverse` = « oui » est le mauvais signe.
  return {
    "mic.diag.https": { val: !!window.isSecureContext },
    "mic.diag.api": { val: !!(md && md.getUserMedia) },
    "mic.diag.recorder": { val: !!window.MediaRecorder },
    "mic.diag.installed": { val: isStandalonePWA(), inverse: true },
    "mic.diag.inapp": { val: inAppBrowser(), inverse: true },
  };
}
function renderMicDiag(info, nbInputs, gumOK, errName, perm) {
  const box = $("#mic-diag");
  if (!box) return;
  const li = Object.entries(info).map(([k, o]) => {
    const v = o.val, bad = o.inverse ? v : !v;
    return `<li>${t(k)} : <span class="${bad ? "bad" : "ok"}">${v ? t("mic.yes") : t("mic.no")}</span></li>`;
  }).join("");
  const permLine = perm
    ? `<li>${t("mic.diag.perm")} : <span class="${perm === "granted" ? "ok" : (perm === "denied" ? "bad" : "")}">${perm}</span></li>`
    : "";
  const extra =
    `<li>${t("mic.diag.detected")} : <span class="${Number(nbInputs) > 0 ? "ok" : "bad"}">${nbInputs}</span></li>`
    + `<li>${t("mic.diag.access")} : <span class="${gumOK ? "ok" : "bad"}">${gumOK ? t("mic.ok") : t("mic.fail") + (errName ? " (" + errName + ")" : "")}</span></li>`;
  box.hidden = false;
  box.innerHTML = "<h4>" + t("mic.diag.title") + "</h4><ul>" + li + permLine + extra + "</ul>"
    + (gumOK
      ? '<div class="advice ok">' + t("mic.works") + "</div>"
      : '<div class="advice">' + micAdvice(errName, perm, nbInputs) + "</div>");
}
/** Lance un diagnostic complet (à la demande, bouton « Tester le micro »). */
async function testMic() {
  const box = $("#mic-diag");
  if (box) { box.hidden = false; box.innerHTML = "<h4>" + t("mic.diag.title.wip") + "</h4>"; }
  const md = navigator.mediaDevices;
  let nbInputs = "?", gumOK = false, errName = "", perm = "";
  try {
    if (navigator.permissions && navigator.permissions.query)
      perm = (await navigator.permissions.query({ name: "microphone" })).state; // granted|denied|prompt
  } catch (_) { perm = t("mic.perm.na"); }
  try {
    if (md && md.enumerateDevices)
      nbInputs = (await md.enumerateDevices()).filter((d) => d.kind === "audioinput").length;
  } catch (_) { /* peut échouer avant permission */ }
  try { const s = await acquireMicStream(); gumOK = true; s.getTracks().forEach((t) => t.stop()); }
  catch (e) { errName = e.name || String(e); }
  renderMicDiag(micStaticInfo(), nbInputs, gumOK, errName, perm);
}
function clearAudio() {
  audioBlob = null;
  audioDurationMs = 0;
  renderAudio();
}
/** Monte le lecteur SUR-MESURE sur un audio LOCAL (blob) — aperçu d'enregistrement,
    correction… → même rendu premium (onde, minuteur) que dans Explorer. */
function mountLocalAudioPlayer(container, blobUrl, durMs) {
  if (!container) return;
  container.innerHTML = "";
  const box = document.createElement("div");
  box.className = "entry-audio";
  box.dataset.audioSrc = blobUrl;
  if (durMs && durMs > 0) box.dataset.audioDur = String(Math.round(durMs));
  const audio = document.createElement("audio");
  audio.preload = "metadata"; audio.src = blobUrl;
  box.appendChild(audio);
  container.appendChild(box);
  mountAudioPlayer(box, audio);
}
function renderAudio() {
  const wrap = $("#audio-preview");
  wrap.innerHTML = "";
  const actions = $("#audio-actions");   // ligne Découper / retirer, sous le cadre
  if (audioBlob) {
    mountLocalAudioPlayer(wrap, URL.createObjectURL(audioBlob), audioDurationMs);
    if (actions) actions.hidden = false;
  } else {
    if (actions) actions.hidden = true;
  }
}

// --- Découpe d'un enregistrement (#47) : garder une portion, jeter le reste. ---
// L'outil décode l'enregistrement (Web Audio) une fois, puis toute la découpe passe
// par le module PUR audiotrim.js (testé). « Garder cette partie » remplace l'audio
// courant par un WAV de la seule zone sélectionnée.
let _trimChannels = null, _trimSR = 48000, _trimTotal = 0, _trimStart = 0, _trimEnd = 0, _trimDrag = null;

async function openTrim() {
  if (!audioBlob) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(await audioBlob.arrayBuffer());
    if (ctx.close) ctx.close();
    _trimSR = buf.sampleRate;
    _trimChannels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) _trimChannels.push(buf.getChannelData(c));
    _trimTotal = samplesDuration(_trimChannels, _trimSR);
  } catch (e) { toast(t("trim.decodeErr"), "warn"); return; }
  _trimStart = 0; _trimEnd = _trimTotal;
  syncTrimInputs(); drawTrimWave();
  const m = $("#trim-modal"); if (m) m.hidden = false;
}
function trimClose() {
  const m = $("#trim-modal"); if (m) m.hidden = true;
  const a = $("#trim-audio"); if (a) { try { a.pause(); } catch (e) { /* ok */ } }
  if (_trimRaf) cancelAnimationFrame(_trimRaf);
  _trimRaf = 0; _trimPlayhead = null; _trimChannels = null; _trimDrag = null;
}
function clampTrim() {
  _trimStart = Math.max(0, Math.min(_trimStart, _trimTotal));
  _trimEnd = Math.max(_trimStart, Math.min(_trimEnd, _trimTotal));
}
function syncTrimInputs() {
  const si = $("#trim-start"), ei = $("#trim-end"), du = $("#trim-dur");
  if (si) { si.max = _trimTotal.toFixed(2); si.value = _trimStart.toFixed(2); }
  if (ei) { ei.max = _trimTotal.toFixed(2); ei.value = _trimEnd.toFixed(2); }
  if (du) du.textContent = t("trim.dur").replace("{d}", Math.max(0, _trimEnd - _trimStart).toFixed(2));
}
let _trimPlayhead = null, _trimRaf = 0;
function drawTrimWave() {
  const cv = $("#trim-wave"); if (!cv || !_trimChannels || _trimTotal <= 0) return;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, mid = H / 2;
  const cs = getComputedStyle(document.documentElement);
  const cyan = (cs.getPropertyValue("--cyan") || "#22d3ee").trim();
  const gold = (cs.getPropertyValue("--gold") || "#e5c07b").trim();
  const muted = (cs.getPropertyValue("--muted") || "#88a").trim();
  g.clearRect(0, 0, W, H);
  const ch = _trimChannels[0] || new Float32Array(0), n = ch.length;
  const xa = _trimStart / _trimTotal * W, xb = _trimEnd / _trimTotal * W;
  // Barres d'amplitude BIEN VISIBLES : DANS la sélection = cyan vif (on repère les zones fortes),
  // DEHORS = grisé estompé. Hauteur minimale 1px pour toujours voir la ligne médiane.
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor(x / W * n), i1 = Math.floor((x + 1) / W * n);
    let mx = 0; for (let i = i0; i < i1; i++) { const v = Math.abs(ch[i] || 0); if (v > mx) mx = v; }
    const h = Math.max(1, mx * (mid - 4));
    const inSel = x >= xa && x <= xb;
    g.strokeStyle = inSel ? cyan : muted; g.globalAlpha = inSel ? 0.95 : 0.42;
    g.beginPath(); g.moveTo(x + 0.5, mid - h); g.lineTo(x + 0.5, mid + h); g.stroke();
  }
  g.globalAlpha = 1;
  // Voile de sélection + poignées.
  g.fillStyle = cyan; g.globalAlpha = 0.10; g.fillRect(xa, 0, Math.max(0, xb - xa), H); g.globalAlpha = 1;
  g.strokeStyle = cyan; g.lineWidth = 2; g.fillStyle = cyan;
  for (const x of [xa, xb]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillRect(x - 3, mid - 13, 6, 26); }
  // CURSEUR de progression pendant l'écoute (comme le lecteur principal).
  if (_trimPlayhead != null) {
    const xp = Math.max(0, Math.min(W, _trimPlayhead / _trimTotal * W));
    g.strokeStyle = gold; g.lineWidth = 2.5; g.beginPath(); g.moveTo(xp, 0); g.lineTo(xp, H); g.stroke();
    g.fillStyle = gold; g.beginPath(); g.arc(xp, mid, 4.5, 0, Math.PI * 2); g.fill();
  }
}
function trimXToTime(clientX) {
  const cv = $("#trim-wave"), r = cv.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * _trimTotal;
}
function onTrimDown(e) {
  if (!_trimChannels) return;
  const tm = trimXToTime(e.clientX);
  _trimDrag = Math.abs(tm - _trimStart) <= Math.abs(tm - _trimEnd) ? "a" : "b";
  onTrimMove(e);
}
function onTrimMove(e) {
  if (!_trimDrag) return;
  const tm = trimXToTime(e.clientX);
  if (_trimDrag === "a") _trimStart = tm; else _trimEnd = tm;
  clampTrim(); syncTrimInputs(); drawTrimWave();
}
function onTrimUp() { _trimDrag = null; }
/** Construit un WAV de la seule zone sélectionnée (via audiotrim.js, pur). */
function trimSelectionBlob() {
  const sl = sliceSamples(_trimChannels, _trimSR, _trimStart, _trimEnd);
  if (!sl.channels.length || !sl.channels[0].length) return null;
  return { blob: new Blob([encodeWavBytes(sl.channels, sl.sampleRate)], { type: "audio/wav" }),
           durMs: Math.round(sl.durationSec * 1000) };
}
function _trimStopPlayhead() {
  if (_trimRaf) cancelAnimationFrame(_trimRaf);
  _trimRaf = 0; _trimPlayhead = null; drawTrimWave();
}
function trimPlaySelection() {
  const sel = trimSelectionBlob();
  if (!sel) { toast(t("trim.empty"), "warn"); return; }
  const a = $("#trim-audio"); if (!a) return;
  if (a._url) URL.revokeObjectURL(a._url);
  a._url = URL.createObjectURL(sel.blob); a.src = a._url;
  // Curseur de progression : on plaque le temps de lecture (relatif à la sélection) sur l'onde.
  const loop = () => {
    _trimPlayhead = _trimStart + (a.currentTime || 0);
    drawTrimWave();
    if (!a.paused && !a.ended) _trimRaf = requestAnimationFrame(loop); else _trimRaf = 0;
  };
  a.onended = _trimStopPlayhead; a.onpause = _trimStopPlayhead;
  a.play().then(() => { if (_trimRaf) cancelAnimationFrame(_trimRaf); _trimRaf = requestAnimationFrame(loop); })
    .catch(() => { _trimStopPlayhead(); /* geste utilisateur requis parfois : sans gravité */ });
}
function trimKeep() {
  const sel = trimSelectionBlob();
  if (!sel) { toast(t("trim.empty"), "warn"); return; }
  audioBlob = sel.blob; audioDurationMs = sel.durMs;
  trimClose(); renderAudio(); toast(t("trim.kept"), "ok");
}
function trimAutoSilence() {
  if (!_trimChannels) return;
  const b = detectSilenceBounds(_trimChannels, _trimSR, 0.02, 0.08);
  _trimStart = b.startSec; _trimEnd = b.endSec; clampTrim(); syncTrimInputs(); drawTrimWave();
}
function initTrim() {
  const cv = $("#trim-wave"); if (!cv) return;
  cv.addEventListener("pointerdown", onTrimDown);
  window.addEventListener("pointermove", onTrimMove);
  window.addEventListener("pointerup", onTrimUp);
  const si = $("#trim-start"), ei = $("#trim-end");
  if (si) si.addEventListener("input", () => { _trimStart = Number(si.value) || 0; clampTrim(); syncTrimInputs(); drawTrimWave(); });
  if (ei) ei.addEventListener("input", () => { _trimEnd = Number(ei.value) || 0; clampTrim(); syncTrimInputs(); drawTrimWave(); });
  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  bind("#btn-trim-audio", openTrim);
  bind("#trim-silence", trimAutoSilence);
  bind("#trim-play", trimPlaySelection);
  bind("#trim-keep", trimKeep);
  bind("#trim-cancel", trimClose);
}

// --- Sauvegarde locale ---------------------------------------------------
async function saveContribution() {
  // #48 : en mode proposé, on enregistre le mot source CANONIQUE (français) même si
  // l'interface l'affiche en anglais → le corpus reste cohérent (regroupement Explorer).
  const srcEl = $("#source");
  const source = nfc(((srcEl.dataset.canon || srcEl.value) + "").trim());
  const target = nfc($("#target").value.trim());
  const c = collectContributeur();

  if (!profileComplete()) {
    toast(t("toast.profile.fill"), "warn");
    openProfile(true);
    return;
  }
  if (activity === "transcribe") {
    if (!source) { toast(t("toast.need.source"), "warn"); return; }
    if (!audioBlob) { toast(t("toast.need.audio"), "warn"); return; }
  } else if (!source || !target) {
    toast(t("toast.need.both"), "warn");
    return;
  }

  // Couche 1 anti-mauvais étiquetage : on CONFIRME la langue de la contribution tant qu'elle
  // n'a pas été validée cette session, ou si l'écriture du texte contredit la langue choisie
  // (lettres du ngiemboon alors que la langue cible est autre). Empêche « je transcris en X,
  // la base note Y » sans avoir à passer par l'admin.
  {
    const curLid = getCurrentLangId();
    const scriptDoubt = activity === "translate" && !!target && /[ŋɛɔʉ]/i.test(target) && !usesDedicatedKeyboard(curLid);
    if (_langAck !== curLid || scriptDoubt) {
      const okLang = await confirmLang(curLid, scriptDoubt);
      if (!okLang) { openLangChoice(); return; }
      _langAck = curLid;
      updateWorkLang();
    }
  }

  const fr2nge = direction === "fr2nge";
  const lid = canonLangId(getCurrentLangId());   // code canonique (nge, bas, dua, …)
  const rec = {
    client_id: (crypto.randomUUID && crypto.randomUUID()) || "c-" + Date.now(),
    direction: fr2nge ? "fr2" + lid : lid + "2fr",   // direction qualifiée par le VRAI code
    langue: lid,
    source_lang: fr2nge ? "fr" : lid,
    target_lang: fr2nge ? lid : "fr",
    source_text: source,
    target_text: target,
    domaine: $("#domaine").value.trim(),
    note: $("#note").value.trim(),
    contributeur: c,
    credit_display: creditDisplay(),   // auteur affichable (pour notifier le demandeur d'une réponse)
    consentement: !!c.consentement,
    device_id: deviceId(),
    created_at: new Date().toISOString(),
    status: "local",
    audioBlob: audioBlob || null,
    audioMeta: audioBlob
      ? { present: true, format: audioBlob.type || "audio/webm", duree_ms: audioDurationMs }
      : { present: false },
  };
  if (mode === "proposer" && currentProp) {
    rec.proposition_id = currentProp.id;
    rec.proposition_cat = currentProp.cat;
    // Métadonnées NLP (conjugaison/pronom/pluriel…) : voyagent avec la contribution → matière
    // d'entraînement structurée (temps, personne, nombre, singulier…).
    if (currentProp.meta) rec.proposition_meta = currentProp.meta;
  }
  // R4 : enrichissement linguistique du mot (nature, classe nominale, exemple, synonymes…), tout
  // facultatif → stocké en métadonnées structurées avec la contribution (vrai dictionnaire + NLP).
  const _wm = collectWordMeta();
  if (_wm) rec.word_meta = _wm;
  // lot 5 : réponse à une DEMANDE de la communauté -> relie la contribution à la
  // demande (compte comme réponse + notifie le demandeur, côté backend).
  const reqId = _currentReqId;
  if (reqId) rec.request_id = reqId;
  await DB.put(rec);
  // Contribuer DANS une langue = la marquer comme langue d'appartenance (peuplement LÉGITIME,
  // fondé sur une action réelle, jamais deviné). Avec la déclaration, seule source des « langues ».
  addProfileLangue(lid);
  markDoneText(rec.source_text);   // cet item ne sera plus proposé à CET utilisateur
  if (mode === "proposer" && currentProp) {
    loadProposition(); // enchaîne un item NON encore traité (tirage aléatoire)
  } else {
    resetForm();
  }
  if (reqId) { _currentReqId = null; refreshReqStrip(); }   // la demande traitée disparaît du bandeau
  await refresh();
  kickReconcile();            // tente l'envoi tout de suite, puis en boucle jusqu'à confirmation
  toast(t("toast.saved.local"), "ok");
  celebrate($("#btn-save"));  // micro-célébration sobre (halo + confettis Ndop)
  focusSourceCentered();      // après « Enregistrer », on recentre sur l'OBJECTIF : le mot source
                              // (mot proposé, ou champ à remplir pour le suivant) — prêt à enchaîner.
}
/** Ramène l'utilisateur à l'objectif après un enregistrement : le champ SOURCE (mot proposé en
    mode « proposer », ou champ à remplir en mode libre) est centré à l'écran et prend le focus. */
function focusSourceCentered() {
  const sw = $("#source-wrap"), s = $("#source");
  try { if (sw) sw.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* ok */ }
  if (s) { try { s.focus({ preventScroll: true }); } catch (e) { try { s.focus(); } catch (e2) { /* ok */ } } }
}
// --- Détection de DOUBLON en mode libre : si le mot saisi a déjà été traité par CET utilisateur,
// on l'informe, on grise la saisie de la contribution, et on lui propose de réécouter/relire sa
// version, d'en refaire une autre malgré tout, ou de passer à un autre mot. Le mode « proposer »
// évite déjà les répétitions ; ce garde-fou couvre le cas où l'utilisateur choisit ses propres mots.
let _dupOverride = "";   // mot que l'utilisateur a explicitement choisi de REFAIRE malgré le doublon
async function checkSourceDuplicate() {
  const warn = $("#dup-warn"); if (!warn) return;
  const n = normTxt(($("#source") && $("#source").value) || "");
  if (mode !== "libre" || _currentReqId || !n || _dupOverride === n || !_doneTexts.has(n)) {
    warn.hidden = true; lockDupZone(false); return;
  }
  lockDupZone(true);                        // DOUBLON : on grise la saisie de la nouvelle contribution
  const prev = $("#dup-prev"); if (prev) prev.innerHTML = "";
  try {
    const mine = (await DB.all()).filter((r) => normTxt(r.source_text) === n)
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const it = mine[0];
    if (it && prev) {
      if (it.audioBlob) {                   // réécouter sa prononciation précédente
        const wrap = document.createElement("div"); wrap.className = "dup-prev-audio"; prev.appendChild(wrap);
        try { mountLocalAudioPlayer(wrap, URL.createObjectURL(it.audioBlob), it.audioMeta && it.audioMeta.duree_ms); } catch (e) { /* ok */ }
      }
      if (it.target_text) {                 // relire sa traduction précédente
        const pp = document.createElement("p"); pp.className = "dup-prev-trad";
        pp.innerHTML = `<span class="dup-prev-lbl">${escapeHtml(t("dup.your"))}</span> <b>${escapeHtml(it.target_text)}</b>`;
        prev.appendChild(pp);
      }
    }
  } catch (e) { /* base indispo : on affiche au moins l'alerte */ }
  warn.hidden = false;
}
/** Grise (verrouille) la saisie d'une NOUVELLE contribution tant qu'un doublon est signalé. */
function lockDupZone(locked) {
  const wc = $("#work-card"); if (wc) wc.classList.toggle("work-dup-locked", !!locked);
  ["#target", "#btn-rec", "#btn-save"].forEach((s) => { const e = $(s); if (e) e.disabled = !!locked; });
}

function resetForm() {
  _currentReqId = null;                // plus de réponse à une demande en cours
  $("#source").value = "";
  $("#source").readOnly = (mode === "proposer");   // libère la source imposée d'une demande
  delete $("#source").dataset.canon;   // #48 : pas de mot canonique résiduel
  $("#target").value = "";
  $("#domaine").value = "";
  $("#note").value = "";
  clearAudio();
  _dupOverride = "";                    // source vidée → plus d'alerte doublon en attente
  checkSourceDuplicate();
  // Même page → le défilement ne bouge pas (focus sans scroll).
  keepScroll(() => { try { $("#source").focus({ preventScroll: true }); } catch (e) { /* ok */ } });
}

function villageValue() {
  return $("#c-village").value.trim();
}
/** Nom affiché publiquement selon le mode de crédit choisi (opt-in).
    « prenom » → prénom seul ; « sigle » → prénom + initiales du nom (Brice K.Z.). */
function computeCredit(mode, prenom, nom) {
  prenom = (prenom || "").trim();
  nom = (nom || "").trim();
  if (mode === "prenom") return prenom || nom;
  if (mode === "sigle") {
    const initiales = nom.split(/\s+/).filter(Boolean)
      .map((w) => w[0].toUpperCase() + ".").join("");
    return [prenom || (nom.split(/\s+/)[0] || ""), initiales].filter(Boolean).join(" ").trim();
  }
  return ""; // « none » → rien affiché (anonyme)
}
function collectContributeur() {
  const nom = $("#c-nom").value.trim();
  const prenom = $("#c-prenom").value.trim();
  const creditMode = $("#c-credit-on").checked ? ($("#c-credit-format").value || "prenom") : "none";
  // On PART de l'objet stocké pour PRÉSERVER les champs hors-formulaire (langues
  // d'appartenance notamment), sinon chaque frappe les écraserait.
  const c = Object.assign(loadContributeur(), {
    nom,
    prenom,
    village: villageValue(),
    role: $("#c-role").value,
    email: $("#c-email").value.trim(),
    indicatif: $("#c-indicatif").value.trim(),
    telephone: $("#c-tel").value.trim(),
    consentement: $("#c-consent").checked,
    // DEUXIÈME consentement (distinct du premier) : autorisation d'affichage public du nom.
    // On garde le booléen explicite (pas seulement son résultat credit_display).
    consentement_credit: $("#c-credit-on").checked,
    creditMode,
    credit_display: computeCredit(creditMode, prenom, nom),
  });
  saveContributeur(c);
  updateGate();
  updateCreditUI();
  updateConsentUI();
  return c;
}

// --- Profil obligatoire + navigation entre les 2 vues -------------------
/** E-mail plausible (non vide + forme x@y.z). Le champ e-mail porte un « * » : il DOIT donc
    être réellement obligatoire (et pas seulement dissuasif). */
function isEmailValid(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
}
function profileComplete() {
  const c = loadContributeur();
  return !!(c.nom && c.prenom && c.village && c.role &&
            c.indicatif && c.telephone && c.consentement &&
            isEmailValid(c.email));   // e-mail marqué « * » → réellement exigé (format valide)
}
// Seuil LÉGER pour l'AFFICHAGE des popups (informer/inviter) : le téléphone/indicatif ne sont
// exigés que pour CONTRIBUER (le clic sur un popup revérifie profileComplete via requireProfile).
// Sans ça, un profil mobile plus ancien (sans téléphone) ne recevait plus aucun popup de la file.
function profileBasics() {
  const c = loadContributeur();
  return !!(c.nom && c.prenom && c.consentement);
}

/** Garde FAIL-CLOSED : toute action de contribution (Traduire, Transcrire, Explorer,
    déclarer une langue) exige un profil complet. Sans profil, on n'ouvre PAS l'action ;
    on emmène l'utilisateur vers la création de profil avec une explication claire, et on
    renvoie `false` pour que l'appelant s'interrompe. La SÉLECTION d'une langue reste
    autorisée sans profil (concession voulue) — seules les ACTIONS sont verrouillées. */
function requireProfile(reason) {
  if (profileComplete()) return true;
  openProfile(false);          // on emmène vers le profil ; le popup explicatif s'affiche par-dessus
  showProfileGate();
  return false;
}
/** Popup EXPLICATIF (façon « consignes ») affiché quand on redirige un nouvel arrivant sans
    profil vers la page de profil : il dit POURQUOI et pourquoi un profil est indispensable.
    Le message est TOUJOURS bilingue (i18n) : on n'affiche pas la raison brute passée par les
    appelants, qui est en français littéral (elle servait autrefois à un toast). */
function showProfileGate() {
  const pg = $("#profile-gate"); if (!pg) return;
  const r = $("#pg-reason"); if (r) r.textContent = t("pgate.reason.default");
  pg.hidden = false;
}
function hideProfileGate() { const pg = $("#profile-gate"); if (pg) pg.hidden = true; }

let profileSnapshot = null; // sauvegarde pour « Annuler » en mode édition

// --- Routeur d'URL (hash) : une adresse par écran, Précédent/Suivant, liens profonds ---
// L'app est une SPA (une seule page). Pour se comporter comme les grandes apps web, on
// reflète la vue courante dans l'URL via un hash (#/explorer, #/apropos…). `showView`
// reste l'UNIQUE autorité : à chaque changement de vue, il synchronise le hash. Le bouton
// Précédent/Suivant (popstate) rejoue la route ; un rafraîchissement ou un lien profond
// restaure la même vue (sous réserve du VERROU de profil, qui garde la priorité).
const ROUTE_OF_VIEW = { hub: "accueil", explore: "explorer", about: "apropos",
  bugs: "bugs", profile: "profil", lang: "langue", notifs: "notifications", demander: "demander" };
const VIEW_OF_ROUTE = { accueil: "hub", traduire: "app", transcrire: "app",
  explorer: "explore", apropos: "about", bugs: "bugs", profil: "profile", langue: "lang",
  notifications: "notifs", demander: "demander",
  // Pages légales : 4 routes → une même vue, ancrée sur la bonne section.
  "mentions-legales": "legal", "confidentialite": "legal", "cgu": "legal", "cgv": "legal" };
// Correspondance route ↔ section légale.
const LEGAL_ROUTE_SEC = { "mentions-legales": "mentions", "confidentialite": "confidentialite", "cgu": "cgu", "cgv": "cgv" };
const LEGAL_SEC_ROUTE = { mentions: "mentions-legales", confidentialite: "confidentialite", cgu: "cgu", cgv: "cgv" };
let _replayingHistory = false;   // vrai pendant le rejeu (initial/back/forward) → pas de pushState

/** Route canonique d'une vue (l'espace app dépend de l'activité Traduire/Transcrire). */
function viewToRoute(name) {
  if (name === "app") return activity === "transcribe" ? "transcrire" : "traduire";
  return ROUTE_OF_VIEW[name] || null;   // amorce/present : non routés (transitoires)
}
/** Route demandée par l'URL courante (ou null si aucune/inconnue). */
function hashToRoute() {
  const h = (location.hash || "").replace(/^#\/?/, "").split("?")[0].trim();
  return VIEW_OF_ROUTE[h] ? h : null;
}
/** Lit un paramètre de requête du hash (ex. #/explorer?w=eau&d=fr2nge). */
function hashParam(key) {
  const h = location.hash || "";
  const i = h.indexOf("?");
  if (i < 0) return null;
  try { return new URLSearchParams(h.slice(i + 1)).get(key); } catch (e) { return null; }
}
/** Aligne l'URL sur la vue affichée. pushState en navigation normale, replaceState en rejeu. */
function syncHash(name) {
  const route = viewToRoute(name);
  if (!route) return;                                  // vue transitoire → on ne touche pas l'URL
  const hash = "#/" + route;
  if (location.hash === hash) return;                  // déjà bon → rien
  try {
    if (_replayingHistory) history.replaceState({ v: name }, "", hash);
    else history.pushState({ v: name }, "", hash);
  } catch (e) { /* environnements sans History API : sans gravité */ }
}
/** Ouvre l'écran correspondant à une route (respecte le verrou de profil des actions). */
function routeTo(route) {
  const targetView = VIEW_OF_ROUTE[route];
  if (!targetView) { goHome(); return; }
  // Idempotence : déjà sur cette vue (et bonne activité pour l'app) → ne rien refaire.
  // Exception « legal » : on ré-entre pour pointer sur la bonne section.
  if (targetView === _currentView) {
    if (targetView === "app") {
      const wantAct = route === "transcrire" ? "transcribe" : "translate";
      if (wantAct === activity) return;
    } else if (targetView !== "legal") {
      return;
    }
  }
  switch (route) {
    case "accueil": enterHub(); break;
    case "traduire": enterWork("translate"); break;
    case "transcrire": enterWork("transcribe"); break;
    case "explorer": enterExplore(); break;
    case "apropos": openAbout(); break;
    case "bugs": openBugs(); break;
    case "notifications": openNotifs(); break;
    case "demander": enterDemander(); break;
    case "profil": openProfile(profileComplete()); break;
    case "langue": openLangChoice(); break;
    case "mentions-legales": case "confidentialite": case "cgu": case "cgv":
      openLegal(LEGAL_ROUTE_SEC[route]); break;
    default: goHome();
  }
}
/** Précédent/Suivant du navigateur : on rejoue la route SANS repousser d'entrée d'historique.
    Cas particulier : si le clavier à l'écran est ouvert, « Précédent » le FERME d'abord (comme
    WhatsApp) et on reste sur la vue courante (on ré-affirme son adresse) sans naviguer. */
function onHistoryNav() {
  if (isKbOpen()) {
    _kbDockClose();
    const route = viewToRoute(_currentView);
    if (route) { try { history.pushState({ v: _currentView }, "", "#/" + route); } catch (e) { /* ok */ } }
    return;
  }
  _replayingHistory = true;
  try { routeTo(hashToRoute() || "accueil"); }
  finally { _replayingHistory = false; }
}

/** Affiche l'une des vues : profile · hub · app (Traduire/Transcrire) · explore. */
function showView(name) {
  _currentView = name;
  syncHash(name);   // reflète la vue dans l'URL (une adresse par écran)
  const lv = $("#view-lang"); if (lv) lv.hidden = name !== "lang";
  const av = $("#view-amorce"); if (av) av.hidden = name !== "amorce";
  $("#view-profile").hidden = name !== "profile";
  $("#view-hub").hidden = name !== "hub";
  $("#view-app").hidden = name !== "app";
  $("#view-explore").hidden = name !== "explore";
  $("#view-about").hidden = name !== "about";
  $("#view-bugs").hidden = name !== "bugs";
  const nv = $("#view-notifs"); if (nv) nv.hidden = name !== "notifs";
  const dmv = $("#view-demander"); if (dmv) dmv.hidden = name !== "demander";
  const glv = $("#view-legal"); if (glv) glv.hidden = name !== "legal";
  const nav = $("#main-nav");
  // Les 4 onglets d'activité sont accessibles depuis TOUTES les pages SAUF l'accueil
  // (le hub, où les 4 grandes portes jouent déjà ce rôle).
  if (nav) nav.hidden = (name === "hub");
  // Onglet actif de la barre de navigation (les 4 espaces).
  if (!nav || !nav.hidden) {
    const active = { app: (activity === "transcribe" ? "tab-transcrire" : "tab-traduire"), explore: "tab-explorer", demander: "tab-demander" }[name];
    ["#tab-transcrire", "#tab-traduire", "#tab-explorer", "#tab-demander"].forEach((s) => { const el = $(s); if (el) el.classList.toggle("is-active", ("#" + active) === s); });
  }
  // « Mon profil » : visibilité conditionnée UNIQUEMENT à l'existence d'un profil.
  // Il reste donc affiché sur TOUTES les pages, y compris la vue profil elle-même
  // (il y sert de repère et n'a jamais à disparaître). Sans profil : rien à ouvrir.
  const prof = $("#btn-open-profile");
  if (prof) prof.hidden = !profileComplete();
  // Cloche de notifications : visible dès qu'un profil existe (comme « Mon profil »).
  const bn = $("#btn-notifs");
  if (bn) bn.hidden = !profileComplete();
  // Bouton des langues : TOUJOURS visible (accès à la page des langues même sans langue choisie).
  // Sans langue → libellé générique « Langues » ; avec une langue → son nom.
  const lc = $("#lang-chip");
  if (lc) {
    lc.hidden = false;
    const cn = $("#lang-chip-name");
    if (cn && !hasChosenLang()) cn.textContent = t("chip.langues");
  }
  // Page ACTIVE mise en évidence dans le header (style plat, deux groupes) : on marque le
  // bouton de nav correspondant à la vue courante.
  const NAV_ACTIVE = { hub: "home-link", lang: "lang-chip", about: "about-link", bugs: "bugs-link", profile: "btn-open-profile", notifs: "btn-notifs" };
  document.querySelectorAll(".chips-nav .chip--btn.is-active").forEach((b) => b.classList.remove("is-active"));
  const actId = NAV_ACTIVE[name]; if (actId) { const ab = document.getElementById(actId); if (ab) ab.classList.add("is-active"); }
  try { injectBannerShare(name); } catch (e) { /* jamais bloquant */ }
  window.scrollTo(0, 0);
}
// --- Partage PAR PAGE : chaque page a son URL (langial.com/traduire…) → aperçu (image + texte)
//     propre à la page quand on colle le lien sur WhatsApp/Facebook. Bouton posé sur la bannière.
// Chaque page a son slug (URL propre). Les pages sans page de partage dédiée (accueil, bugs,
// notifs, profil, légales) partagent la racine "" → le bouton existe PARTOUT.
const PAGE_SLUG = { explore: "explorer", demander: "demander", lang: "langues", about: "apropos" };
function bannerShareSlug(name) {
  if (name === "app") return activity === "transcribe" ? "transcrire" : "traduire";
  return Object.prototype.hasOwnProperty.call(PAGE_SLUG, name) ? PAGE_SLUG[name] : "";
}
function injectBannerShare(name) {
  const slug = bannerShareSlug(name);
  const view = document.getElementById("view-" + name);
  // La page À propos utilise .about-hero (bannière pleine largeur) au lieu de .page-banner :
  // on accepte les deux → le bouton de partage est présent sur TOUTES les pages à bannière.
  const banner = view && view.querySelector(".page-banner, .about-hero");
  if (!banner) return;                         // pas de bannière = page transitoire, on n'ajoute rien
  // Bouton SOUS la bannière (barre à l'extérieur) → il ne cache jamais la bannière. Présent sur
  // TOUTES les pages à bannière.
  let bar = banner.nextElementSibling;
  if (!bar || !bar.classList || !bar.classList.contains("banner-share-bar")) {
    bar = document.createElement("div"); bar.className = "banner-share-bar";
    banner.insertAdjacentElement("afterend", bar);
  }
  let btn = bar.querySelector(".banner-share");
  if (!btn) {
    btn = document.createElement("button"); btn.className = "banner-share"; btn.type = "button";
    btn.innerHTML = '<span aria-hidden="true">↗</span> <span class="bs-txt"></span>';
    bar.appendChild(btn);
  }
  btn.querySelector(".bs-txt").textContent = t("banner.share");
  btn.setAttribute("aria-label", t("banner.share"));
  btn.onclick = () => sharePageBanner(slug);
}
// slug d'URL de page → clé de cas de partage (textes marketing de sharecopy.js).
const SLUG_CASE = { "": "home", traduire: "traduire", transcrire: "transcrire", explorer: "explorer", demander: "demander", langues: "langues", apropos: "apropos" };
async function sharePageBanner(slug) {
  const url = PRESENT_URL.replace(/\/$/, "") + (slug ? "/" + slug : "/");
  const caseKey = SLUG_CASE[slug || ""] || "home";
  // Panneau de partage CUSTOM (réseaux + texte marketing propre à chaque plateforme) sur TOUS les
  // supports (mobile/tablette/PC), jamais la feuille native : message soigné et rendu cohérent partout.
  openSharePanel(url, caseKey, {});
}
/** Panneau de partage : réseaux (texte marketing propre à chaque plateforme) + copier le lien. */
let _sharePanelEl = null;
function openSharePanel(url, caseKey, ctx) {
  if (!_sharePanelEl) {
    const ov = document.createElement("div");
    ov.id = "share-panel"; ov.className = "tr-guide"; ov.hidden = true;
    ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-labelledby", "sp-title");
    ov.innerHTML = '<div class="tr-guide-card share-panel-card">' +
      '<button class="incite-close" type="button" aria-label="Fermer">✕</button>' +
      '<h3 id="sp-title" class="sp-title"></h3><p class="sp-sub"></p>' +
      '<div class="sp-bar-host"></div></div>';
    document.body.appendChild(ov);
    const close = () => { ov.hidden = true; };
    ov.querySelector(".incite-close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });   // clic hors carte = fermer
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ov.hidden) close(); });
    _sharePanelEl = ov;
  }
  const ov = _sharePanelEl;
  ov.querySelector(".sp-title").textContent = t("share.panel.title");
  ov.querySelector(".sp-sub").textContent = t("share.panel.sub");
  const lang = getUiLang();
  mountShareBar(ov.querySelector(".sp-bar-host"), {
    url, title: "LANGIAL", toast,
    messageFor: (net) => shareMessage(caseKey, net, ctx || {}, lang),   // texte marketing PAR réseau
    emailSubject: shareSubject(caseKey, lang),
    nets: ["whatsapp", "facebook", "x", "telegram", "linkedin", "tiktok", "instagram", "email"],
    shareOnLabel: t("share.on"), nativeLabel: t("share.native"),
    copyLabel: t("share.copy"), copiedMsg: t("share.copied2"), copyCaptionMsg: t("share.caption.copied"),
  });
  ov.hidden = false;
}

/** Ouvre la page « À propos » (vraie vue de l'app) en mémorisant d'où l'on vient. */
function openAbout() {
  if (_currentView !== "about") _aboutReturn = _currentView;
  showView("about");
  renderTestimonials();
}
// « Ils parlent de nous » : avis RÉELS d'utilisateurs, chargés depuis le backend (publication
// AUTO avec garde-fous côté serveur : longueur, gros mots, 1 par appareil). Section masquée tant
// qu'il n'y en a aucun (jamais de faux avis ni d'encart vide). Les contributeurs actifs sont
// invités à en laisser un (file de popups + bouton « Laisser un mot »).
let _testimonials = [];
async function renderTestimonials() {
  const grid = $("#about-say"), head = $("#about-sec-say");
  if (!grid || !head) return;
  try { _testimonials = await fetchTestimonials(30); } catch (e) { _testimonials = []; }
  const items = (_testimonials || []).filter((x) => x && (x.texte || "").trim());
  const has = items.length > 0;
  head.hidden = !has; grid.hidden = !has;
  if (!has) { grid.innerHTML = ""; return; }
  grid.innerHTML = items.map((x) => {
    const meta = [x.role, x.langue ? _langNameById(x.langue) : ""].filter(Boolean).join(" · ");
    return `<figure class="say-card">
      <blockquote class="say-text">${escapeHtml(x.texte)}</blockquote>
      <figcaption class="say-by"><span class="say-name">${escapeHtml(x.credit || t("say.anon"))}</span>` +
      (meta ? `<span class="say-meta">${escapeHtml(meta)}</span>` : "") + `</figcaption>
    </figure>`;
  }).join("");
}

// --- Formulaire « Laisser un mot » (témoignage) : publication AUTO avec garde-fous ---
const TESTI_DONE_KEY = "langa-testi-done";     // l'utilisateur a déjà laissé un mot
const TESTI_INVITE_KEY = "langa-testi-invite"; // dernier jour d'invitation (anti-spam)
function testimonialDone() { return localStorage.getItem(TESTI_DONE_KEY) === "1"; }
function showTestimonialForm() {
  if (!requireProfile(t("testi.needprofile"))) return;   // un profil est requis (crédit + anti-doublon)
  const m = $("#testi-form"); if (!m) return;
  const c = loadContributeur();
  const ta = $("#testi-text"); if (ta) ta.value = "";
  const err = $("#testi-error"); if (err) err.hidden = true;
  const who = $("#testi-who");
  if (who) { const name = (c.consentement && creditDisplay()) ? creditDisplay() : t("testi.anon"); who.textContent = ti("testi.as", { who: name }); }
  m.hidden = false;
  try { ta.focus(); } catch (e) { /* ok */ }
}
function hideTestimonialForm() { const m = $("#testi-form"); if (m) m.hidden = true; }
async function submitTestimonialForm() {
  const ta = $("#testi-text"), err = $("#testi-error"), btn = $("#testi-send");
  const texte = ((ta && ta.value) || "").trim();
  const showErr = (k) => { if (err) { err.textContent = t(k); err.hidden = false; } };
  if (texte.length < 10) { showErr("testi.err.short"); return; }
  const c = loadContributeur();
  if (btn) btn.disabled = true;
  let res = null;
  try {
    res = await submitTestimonial({
      texte, device_id: deviceId(), consentement: !!c.consentement,
      credit: creditDisplay(), role: c.role || "", langue: getCurrentLangId(),
    });
  } catch (e) { res = null; }
  if (btn) btn.disabled = false;
  if (res && res.ok) {
    try { localStorage.setItem(TESTI_DONE_KEY, "1"); } catch (e) { /* ok */ }
    hideTestimonialForm(); dismissPopup("testi");
    toast(t("testi.thanks"), "ok");
    renderTestimonials();
    return;
  }
  const code = res && res.error;
  showErr(code === "inapproprie" ? "testi.err.bad" : code === "trop_court" ? "testi.err.short" : "testi.err.net");
}
/** Invitation à témoigner : ENFILE un popup pour les contributeurs actifs qui n'ont pas encore
    laissé de mot (au plus 1 invitation/jour). La file gère l'affichage (jamais deux à la fois). */
function maybeInviteTestimonial() {
  if (!profileComplete() || testimonialDone()) return;
  if (!_doneTexts || _doneTexts.size < 3) return;                // au moins quelques contributions
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(TESTI_INVITE_KEY) === today) return;  // 1 invitation / jour max
  try { localStorage.setItem(TESTI_INVITE_KEY, today); } catch (e) { /* ok */ }
  enqueuePopup("testi", () => _renderTestiInvite());
}
function _renderTestiInvite() {
  const bn = $("#incite-banner"); if (!bn) return;
  bn.dataset.ptype = "rate";   // teinte or (valorisation)
  const ico = bn.querySelector(".incite-ico"); if (ico) ico.innerHTML = _popIllHTML("two-talk-ill.webp");
  const msg = $("#incite-msg"); if (msg) msg.textContent = t("testi.invite.msg");
  const lis = $("#incite-listen"); if (lis) { lis.hidden = true; lis.onclick = null; }
  const go = $("#incite-go");
  if (go) { go.textContent = t("testi.invite.cta"); go.onclick = () => { bn.hidden = true; dismissPopup("testi"); showTestimonialForm(); }; }
  bn.hidden = false;
}

// --- Suivi des bugs -------------------------------------------------------
let _bugsReturn = "hub";
function localBugs() {
  try { return JSON.parse(localStorage.getItem("bugsSignales") || "[]"); } catch (e) { return []; }
}
function saveLocalBug(bug) {
  const arr = localBugs();
  if (!arr.some((b) => b.id === bug.id)) { arr.push(bug); localStorage.setItem("bugsSignales", JSON.stringify(arr)); }
}
function bugCardHtml(bug) {
  const resolu = bug.statut === "resolu";
  // Variante anglaise des champs textuels quand la langue d'interface est l'anglais.
  const en = getUiLang() === "en";
  const pick = (k) => (en && bug[k + "_en"]) ? bug[k + "_en"] : bug[k];
  const titre = pick("titre"), description = pick("description"), correctif = pick("correctif"), zone = pick("zone");
  const sevK = { critique: "bug.sev.critique", majeur: "bug.sev.majeur", mineur: "bug.sev.mineur" }[bug.severite];
  const sev = sevK ? t(sevK) : "";
  const locale = en ? "en-GB" : "fr-FR";
  const d = (x) => { try { return x ? new Date(x).toLocaleDateString(locale) : ""; } catch (e) { return x || ""; } };
  return `<li class="bug ${resolu ? "bug--done" : "bug--open"}">` +
    `<div class="bug-top">` +
      `<span class="bug-id">${escapeHtml(bug.id)}</span>` +
      `<span class="badge ${resolu ? "badge--sent" : "badge--local"}">${resolu ? t("bug.done") : t("bug.pending")}</span>` +
      (sev ? `<span class="bug-sev bug-sev--${escapeHtml(bug.severite)}">${sev}</span>` : "") +
      (zone ? `<span class="bug-zone">${escapeHtml(zone)}</span>` : "") +
    `</div>` +
    `<div class="bug-titre">${escapeHtml(titre)}</div>` +
    (description ? `<div class="bug-desc">${escapeHtml(description)}</div>` : "") +
    (resolu && correctif ? `<div class="bug-fix">✅ ${escapeHtml(correctif)}</div>` : "") +
    `<div class="bug-meta">` +
      (bug.detecte_le ? ti("bug.detected", { d: d(bug.detecte_le) }) : "") +
      (resolu && bug.resolu_le ? ` · ${ti("bug.resolved", { d: d(bug.resolu_le) })}` : "") +
      (bug.version ? ` · ${escapeHtml(bug.version)}` : "") +
      (bug.source === "utilisateur" ? ` · ${t("bug.byuser")}` : "") +
    `</div>` +
  `</li>`;
}
async function renderBugs() {
  // Fusion : journal VERSIONNÉ (BUGS) + signalements distants + locaux, dédup par id.
  const { BUGS } = await import("./bugs.js");
  const map = new Map();
  BUGS.forEach((b) => map.set(b.id, b));
  const remote = await fetchBugs();
  (remote || []).forEach((b) => { if (b && b.id && !map.has(b.id)) map.set(b.id, b); });
  localBugs().forEach((b) => { if (b && b.id && !map.has(b.id)) map.set(b.id, b); });
  const all = [...map.values()];
  const open = all.filter((b) => b.statut !== "resolu");
  const done = all.filter((b) => b.statut === "resolu");
  const order = { critique: 0, majeur: 1, mineur: 2 };
  open.sort((a, b) => (order[a.severite] ?? 9) - (order[b.severite] ?? 9));
  done.sort((a, b) => (b.resolu_le || "").localeCompare(a.resolu_le || ""));
  $("#bugs-open-n").textContent = open.length;
  $("#bugs-done-n").textContent = done.length;
  $("#bugs-grp-open").hidden = open.length === 0;
  $("#bugs-grp-done").hidden = done.length === 0;
  $("#bugs-open").innerHTML = open.map(bugCardHtml).join("");
  $("#bugs-done").innerHTML = done.map(bugCardHtml).join("");
}
function openBugs() {
  if (_currentView !== "bugs") _bugsReturn = _currentView;
  showView("bugs");
  renderBugs();
}
/** Ouvre les pages légales, ancrées sur la section demandée (mentions|confidentialite|cgu|cgv). */
let _legalReturn = "hub";
async function openLegal(section) {
  const { legalHtml, LEGAL_SECTIONS } = await import("./legal.js");
  const sec = LEGAL_SEC_ROUTE[section] ? section : "mentions";
  if (_currentView !== "legal") _legalReturn = _currentView || "hub";
  const en = getUiLang() === "en";
  const nav = $("#legal-nav");
  if (nav) nav.innerHTML = LEGAL_SECTIONS.map((s) =>
    `<a href="#legal-${s.id}" class="legal-navlink${s.id === sec ? " is-active" : ""}" data-sec="${s.id}">${en ? s.t.en : s.t.fr}</a>`).join("");
  const content = $("#legal-content");
  if (content) content.innerHTML = legalHtml(getUiLang());
  showView("legal");   // legal n'est PAS dans ROUTE_OF_VIEW → syncHash ne pose pas de hash
  const route = LEGAL_SEC_ROUTE[sec] || "mentions-legales";
  try {
    const st = { v: "legal" }, h = "#/" + route;
    if (_replayingHistory) history.replaceState(st, "", h); else history.pushState(st, "", h);
  } catch (e) { /* ok */ }
  const target = document.getElementById("legal-" + sec);
  if (target) setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
}
async function submitBug() {
  const titre = $("#bug-titre").value.trim();
  const desc = $("#bug-desc").value.trim();
  if (!titre) { toast(t("toast.bug.title"), "warn"); return; }
  const c = loadContributeur();
  const bug = {
    id: "BUG-U-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4),
    titre, description: desc, statut: "en_attente",
    severite: $("#bug-sev").value || "mineur",
    zone: $("#bug-zone").value || "Autre",
    detecte_le: new Date().toISOString().slice(0, 10),
    resolu_le: "", version: "", source: "utilisateur",
    device_id: deviceId(), signale_par: c.credit_display || "",
  };
  saveLocalBug(bug);                     // visible tout de suite pour le rapporteur
  $("#bug-titre").value = ""; $("#bug-desc").value = "";
  $("#bug-status").textContent = t("bug.saved");
  await renderBugs();
  try { await postBug(bug); } catch (e) { /* best-effort ; resignalé à la prochaine ouverture */ }
  toast(t("toast.bug.sent"), "ok");
}

/** Ouvre la vue profil. edit=true → mode modification (depuis l'app). */
function openProfile(edit) {
  profileSnapshot = edit ? loadContributeur() : null;
  // On NE devine PLUS la langue : plus de pré-remplissage automatique depuis la langue courante
  // (souvent la graine nge). Les langues d'appartenance ne se remplissent QUE par un choix
  // explicite (sélecteur de langue), une déclaration, ou une contribution dans une langue.
  renderProfileLangs();
  $("#profile-title").textContent = edit ? t("profile.title.edit") : t("profile.title.welcome");
  // Le profil est OPTIONNEL (navigation libre) : « Annuler » est toujours proposé pour
  // revenir à la consultation sans être piégé sur cet écran.
  $("#btn-profile-cancel").hidden = false;
  $("#btn-profile-continue").textContent = edit ? t("profile.save") : t("profile.continue");
  showView("profile");
  updateProfileGate();
  rehydrateMyContributions();   // #114 : restitue l'historique depuis le serveur (par personne) + Couche 3
}

/** #114 — Ré-hydrate « mes contributions » depuis le SERVEUR (par PERSONNE) : sur un nouvel appareil,
    un utilisateur reconnu (même e-mail/nom, via la cascade backend) RETROUVE tout son historique.
    Importe dans la base locale les contributions confirmées absentes (dédup par server_id), puis
    réaffiche. Best-effort, silencieux hors ligne (on garde alors l'affichage purement local). */
async function rehydrateMyContributions() {
  const c = loadContributeur();
  if (!c || !c.consentement) { renderMyContributions(); return; }
  let owner_hash = "", device_pubkey = "";
  try { owner_hash = await ownerHash(); } catch (e) { /* ok */ }
  try { device_pubkey = await ensureDeviceKey(); } catch (e) { /* ok */ }
  let res = null;
  try { res = await fetchMyContributions({ device_id: deviceId(), owner_hash, device_pubkey, contributeur: c }); }
  catch (e) { res = null; }
  if (res && Array.isArray(res.contributions) && res.contributions.length) {
    let known = new Set();
    try { known = new Set((await DB.all()).map((r) => String(r.server_id || ""))); } catch (e) { /* ok */ }
    for (const s of res.contributions) {
      const sid = String(s.id_contribution || s.server_id || "").trim();
      if (!sid || known.has(sid)) continue;   // déjà en local → on ne duplique pas
      try {
        await DB.put({
          client_id: "srv-" + sid, server_id: sid,
          source_text: s.source_text || "", target_text: s.target_text || "",
          langue: s.langue || "", direction: s.direction || "",
          audio_url: s.audio_url || "", domaine: s.domaine || "", note: s.note || "",
          created_at: s.cree_le || s.recu_le || s.date || "", _rehydrated: true,
        });
      } catch (e) { /* quota/erreur : sans gravité */ }
    }
  }
  renderMyContributions();
}

/** COUCHE 3 — contributions ENVOYÉES par cet appareil (base locale ; server_id présent = confirmée),
    avec correction de la langue mal étiquetée. Source = DB local (le browse local ne sert que des
    exemples). La correction passe par le jeton de propriété (fail-closed côté backend). */
let _mcItems = [];
let _mcSearchWired = false;
async function renderMyContributions() {
  const host = $("#my-contribs"), list = $("#mc-list");
  if (!host || !list) return;
  let items = [];
  try { items = (await DB.all()).filter((r) => r && r.server_id && ((r.source_text || "").trim() || (r.target_text || "").trim())); }
  catch (e) { items = []; }
  const cnt = $("#mc-count");
  if (!items.length) { host.hidden = true; list.innerHTML = ""; _mcItems = []; if (cnt) cnt.textContent = ""; return; }
  items.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  _mcItems = items;
  host.hidden = false;
  // La recherche est câblée UNE fois. Le champ vit hors de #mc-list, donc son focus survit au repaint ;
  // keepScroll garde la position de défilement (règle : une action « même page » ne bouge pas le focus).
  if (!_mcSearchWired) {
    const s = $("#mc-search");
    if (s) { s.addEventListener("input", () => keepScroll(() => _mcPaint(s.value))); _mcSearchWired = true; }
  }
  _mcPaint($("#mc-search") ? $("#mc-search").value : "");
}
/** Peint la liste filtrée + met à jour le compteur. Plafonnée (CAP) pour rester fluide même avec
    des milliers de contributions ; au-delà, la recherche permet de retrouver un mot précis. */
function _mcPaint(q) {
  const list = $("#mc-list"); if (!list) return;
  const query = (q || "").trim().toLowerCase();
  const all = _mcItems || [];
  const matches = query
    ? all.filter((r) => ((r.source_text || "") + " " + (r.target_text || "")).toLowerCase().includes(query))
    : all;
  const cnt = $("#mc-count");
  if (cnt) cnt.textContent = query ? "(" + ti("mc.count.match", { n: matches.length, total: all.length }) + ")" : "(" + all.length + ")";
  const CAP = 300;
  const shown = matches.slice(0, CAP);
  const langs = visibleLanguages(knownLanguages());
  list.innerHTML = shown.map((r) => {
    const cur = canonLangId(r.langue || entryLang(r));
    const opts = langs.map((l) => `<option value="${escapeHtml(l.id)}"${canonLangId(l.id) === cur ? " selected" : ""}>${escapeHtml(l.nom)}</option>`).join("");
    const w = (r.source_text || "").trim(), tr = (r.target_text || "").trim();
    const label = escapeHtml(w) + (tr ? ' <span class="mc-arrow">→</span> <span class="mc-target">' + escapeHtml(tr) + '</span>' : "");
    const hasAudio = isPlayable(r.audio_url), hasTrad = !!tr;
    // Type : une contribution peut porter une prononciation (voix) ET/OU une traduction écrite.
    const badges = (hasAudio ? `<span class="mc-type mc-type--voice">${escapeHtml(t("mc.type.voice"))}</span>` : "")
                 + (hasTrad ? `<span class="mc-type mc-type--trad">${escapeHtml(t("mc.type.trad"))}</span>` : "");
    const playBtn = hasAudio ? `<button type="button" class="mc-play" data-audio="${escapeHtml(r.audio_url)}">▶ ${escapeHtml(t("mc.listen"))}</button>` : "";
    // CONTENU modifiable directement : la traduction écrite (texte) et/ou la voix (ré-enregistrement).
    const editTradBtn = hasTrad ? `<button type="button" class="mc-edit-trad">✎ ${escapeHtml(t("mc.edit.trad"))}</button>` : "";
    const editVoiceBtn = hasAudio ? `<button type="button" class="mc-edit-voice">🎙 ${escapeHtml(t("mc.edit.voice"))}</button>` : "";
    return `<div class="mc-item" data-sid="${escapeHtml(String(r.server_id))}">
      <div class="mc-main">
        <div class="mc-types">${badges}</div>
        <div class="mc-word">${label || t("mc.audio")}</div>
        <div class="mc-actions">${playBtn}${editTradBtn}${editVoiceBtn}</div>
      </div>
      <div class="mc-trad-edit" hidden>
        <input type="text" class="mc-trad-input" value="${escapeHtml(tr)}" maxlength="2000" />
        <div class="mc-edit-btns">
          <button type="button" class="btn mc-edit-save-trad">${escapeHtml(t("mc.edit.save"))}</button>
          <button type="button" class="mc-edit-cancel">${escapeHtml(t("mc.edit.cancel"))}</button>
        </div>
      </div>
      <div class="mc-voice-edit" hidden>
        <button type="button" class="btn btn--rec mc-voice-rec">${escapeHtml(t("mc.edit.rec.start"))}</button>
        <span class="rec-timer mc-voice-timer" hidden>00:00</span>
        <span class="mc-voice-preview"></span>
        <div class="mc-edit-btns">
          <button type="button" class="btn mc-edit-save-voice" disabled>${escapeHtml(t("mc.edit.save"))}</button>
          <button type="button" class="mc-edit-cancel">${escapeHtml(t("mc.edit.cancel"))}</button>
        </div>
      </div>
      <details class="mc-lang-more">
        <summary>${escapeHtml(t("mc.lang.more"))}</summary>
        <div class="mc-edit">
          <label class="mc-lang"><span data-i18n="mc.lang">Langue</span>
            <select class="mc-lang-sel">${opts}</select></label>
          <button type="button" class="btn mc-save" data-i18n="mc.save">Corriger</button>
        </div>
      </details>
    </div>`;
  }).join("")
    + (query && !matches.length ? `<div class="mc-empty">${escapeHtml(t("mc.noresult"))}</div>` : "")
    + (matches.length > CAP ? `<div class="mc-more">${escapeHtml(ti("mc.more", { n: CAP, total: matches.length }))}</div>` : "");
  refreshEnhancedSelects();   // habille les <select> comme le reste
}
let _mcAudioEl = null, _mcPlayingBtn = null;
/** Écoute d'une contribution depuis la liste du profil, AVEC le même dynamisme que les popups :
    « Chargement… » pendant le téléchargement (l'audio Drive a de la latence), puis « Lecture… »,
    et restauration du libellé à la fin. Un seul lecteur partagé ; on restaure le bouton précédent. */
async function _mcPlay(btn, url) {
  if (!btn || !url) return;
  if (!_mcAudioEl) _mcAudioEl = new Audio();
  const au = _mcAudioEl;
  const dflt = "▶ " + t("mc.listen");
  if (_mcPlayingBtn && _mcPlayingBtn !== btn) {
    const p = _mcPlayingBtn; p.disabled = false; p.classList.remove("is-loading", "is-playing");
    p.textContent = p.dataset.label || dflt;
  }
  if (!btn.dataset.label) btn.dataset.label = btn.textContent || dflt;
  const restore = () => { btn.disabled = false; btn.classList.remove("is-loading", "is-playing"); btn.textContent = btn.dataset.label; if (_mcPlayingBtn === btn) _mcPlayingBtn = null; };
  const setStatus = (m) => { if (m) btn.textContent = m; };
  try { au.pause(); } catch (e) { /* ok */ }
  _mcPlayingBtn = btn;
  btn.disabled = true; btn.classList.add("is-loading"); btn.textContent = t("audio.loading");
  const did = driveFileId(url);
  try { if (did) { await loadDriveAudioInto(au, did, setStatus); } else { au.src = url; au.load(); } }
  catch (e) { /* on tente quand même la lecture */ }
  try {
    await au.play();
    btn.disabled = false; btn.classList.remove("is-loading"); btn.classList.add("is-playing"); btn.textContent = t("audio.playing");
  } catch (e) { restore(); return; }
  au.onended = restore; au.onpause = restore; au.onerror = restore;
}
async function _mcSave(sid, newLid, itemEl) {
  const lid = canonLangId(newLid) || String(newLid || "").trim();
  let rec = null;
  try { rec = (await DB.all()).find((r) => String(r.server_id) === String(sid)); } catch (e) { rec = null; }
  if (!rec || !lid) return;   // correction seulement : sans mot local ou langue valide, on ne fait rien (aucun blocage)
  const orient = dirOrient(rec.direction);
  const patch = {
    langue: lid,
    direction: orient === "l2fr" ? lid + "2fr" : "fr2" + lid,
    source_lang: orient === "l2fr" ? lid : "fr",
    target_lang: orient === "l2fr" ? "fr" : lid,
  };
  const btn = itemEl && itemEl.querySelector(".mc-save");
  if (btn) btn.disabled = true;
  let r = null;
  try { r = await updateContribution({ id: String(sid), device_id: deviceId(), owner_token: ownerToken(), patch }); }
  catch (e) { r = null; }
  if (btn) btn.disabled = false;
  if (!r || r.ok === false) { toast((r && r.error) ? (t("mc.err") + " : " + r.error) : t("mc.err"), "err"); return; }
  try { Object.assign(rec, patch); await DB.put(rec); } catch (e) { /* copie locale best-effort */ }
  toast(t("mc.saved"), "ok");
  renderMyContributions();
}

/** Édite directement le TEXTE de la traduction d'une contribution déjà envoyée (contenu, pas
    seulement sa langue). Propriétaire uniquement (autorisation multi-appareils côté .gs). */
async function _mcSaveText(sid, newText, itemEl, box) {
  const texte = nfc((newText || "").trim());
  if (!texte) { toast(t("mc.edit.empty"), "warn"); return; }
  const btn = box && box.querySelector(".mc-edit-save-trad");
  if (btn) btn.disabled = true;
  let r = null;
  try { r = await updateContribution({ id: String(sid), device_id: deviceId(), owner_token: ownerToken(), patch: { target_text: texte } }); }
  catch (e) { r = null; }
  if (btn) btn.disabled = false;
  if (!r || r.ok === false) { toast((r && r.error) ? (t("mc.err") + " : " + r.error) : t("mc.err"), "err"); return; }
  try {
    const all = await DB.all(); const rec = all.find((x) => String(x.server_id) === String(sid));
    if (rec) { rec.target_text = texte; await DB.put(rec); }
  } catch (e) { /* copie locale best-effort */ }
  toast(t("mc.saved"), "ok");
  renderMyContributions();
}

let _mcRec = null, _mcChunks = [], _mcRecTimer = null, _mcRecStart = 0;
/** Démarre/arrête l'enregistrement du RÉ-ENREGISTREMENT de voix pour une contribution du profil.
    Même mécanique que le micro de saisie (MediaRecorder), scoped au panneau de l'item cliqué. */
async function _mcToggleVoiceRec(btn) {
  const box = btn.closest(".mc-voice-edit"); if (!box) return;
  if (_mcRec && _mcRec.state === "recording") { _mcRec.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(t("mic.err.other"), "err"); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _mcChunks = [];
    _mcRec = new MediaRecorder(stream);
    _mcRec.ondataavailable = (ev) => { if (ev.data.size) _mcChunks.push(ev.data); };
    _mcRec.onstop = () => {
      const blob = new Blob(_mcChunks, { type: _mcRec.mimeType || "audio/webm" });
      box._mcBlob = blob; box._mcDur = Date.now() - _mcRecStart;
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* ok */ }
      btn.textContent = t("mc.edit.rec.start"); btn.classList.remove("is-rec");
      const timer = box.querySelector(".mc-voice-timer"); if (timer) timer.hidden = true;
      clearInterval(_mcRecTimer);
      const prev = box.querySelector(".mc-voice-preview");
      if (prev) { prev.innerHTML = ""; mountLocalAudioPlayer(prev, URL.createObjectURL(blob), box._mcDur || 0); }
      const saveBtn = box.querySelector(".mc-edit-save-voice"); if (saveBtn) saveBtn.disabled = false;
    };
    _mcRecStart = Date.now();
    _mcRec.start();
    btn.textContent = t("mc.edit.rec.stop"); btn.classList.add("is-rec");
    const timer = box.querySelector(".mc-voice-timer");
    if (timer) { timer.hidden = false; timer.textContent = "00:00"; clearInterval(_mcRecTimer); _mcRecTimer = setInterval(() => { timer.textContent = fmtRec(Date.now() - _mcRecStart); }, 250); }
  } catch (e) { toast(t("mic.err.denied"), "err"); }
}
/** Envoie le ré-enregistrement (remplace l'audio en base, colonnes 15/16 du .gs). */
async function _mcSaveVoice(sid, blob, durMs, itemEl, box) {
  const btn = box && box.querySelector(".mc-edit-save-voice");
  if (btn) btn.disabled = true;
  let r = null;
  try {
    const b64 = await blobToBase64Corr(blob);
    r = await updateContribution({
      id: String(sid), device_id: deviceId(), owner_token: ownerToken(), patch: {},
      audio_base64: b64, audio: { present: true, format: blob.type || "audio/webm", duree_ms: durMs || 0 },
    });
  } catch (e) { r = null; }
  if (btn) btn.disabled = false;
  if (!r || r.ok === false) { toast((r && r.error) ? (t("mc.err") + " : " + r.error) : t("mc.err"), "err"); return; }
  try {
    const all = await DB.all(); const rec = all.find((x) => String(x.server_id) === String(sid));
    if (rec && r.patch && r.patch.audio_url) { rec.audio_url = r.patch.audio_url; await DB.put(rec); }
  } catch (e) { /* copie locale best-effort */ }
  toast(t("mc.saved"), "ok");
  box._mcBlob = null; box._mcDur = 0;
  renderMyContributions();
}

const CREDIT_DEFAULT_KEY = "langa-credit-defaut-v1";
/** SYNC UNIQUE (choix Brice 2026-07-23) : crédit public par défaut « oui / prénom ». Pour un
    profil DÉJÀ existant dont l'affichage du nom n'est pas activé localement, on l'active UNE seule
    fois (puis on pose un drapeau) et on le pousse en base. Ensuite l'utilisateur est maître : s'il
    décoche plus tard, son choix fait foi (upsert bidirectionnel). Les nouveaux profils ont déjà le
    défaut coché via le formulaire ; on pose juste le drapeau pour ne pas repasser. */
function applyCreditDefaultOnce() {
  try {
    if (localStorage.getItem(CREDIT_DEFAULT_KEY)) return;   // déjà appliqué → on ne force plus jamais
    const c = loadContributeur();
    const exists = !!(c && (c.nom || c.prenom || c.email));
    if (exists && !(c.creditMode && c.creditMode !== "none")) {
      c.creditMode = "prenom";
      c.consentement_credit = true;
      c.credit_display = computeCredit("prenom", c.prenom, c.nom);
      saveContributeur(c);
      try { pushUserProfile(); } catch (e) { /* offline : repartira au prochain envoi */ }
    }
    localStorage.setItem(CREDIT_DEFAULT_KEY, "1");
  } catch (e) { /* jamais bloquant */ }
}

/** Remonte le PROFIL courant vers la base (best-effort, offline-safe) : tout profil
    complété doit apparaître dans l'Excel, même sans la moindre contribution. Upsert
    idempotent par device_id, sans compter de contribution. */
async function pushUserProfile() {
  const c = loadContributeur();
  if (!c.consentement) return;   // pas de remontée sans consentement explicite
  let owner_hash = "";
  try { owner_hash = await ownerHash(); } catch (e) { owner_hash = ""; }   // enregistre/rafraîchit le hash du jeton (rétroactif)
  let device_pubkey = "";
  try { device_pubkey = await ensureDeviceKey(); } catch (e) { device_pubkey = ""; }   // clé publique d'appareil (identité)
  try {
    declareUser({
      device_id: deviceId(),
      consentement: !!c.consentement,
      owner_hash,   // Couche 2 : le backend mémorise ce hash pour autoriser plus tard une correction
      device_pubkey,   // identité cryptographique de l'appareil (clé publique)
      // AUCUNE langue devinée : on n'envoie que les langues EXPLICITEMENT choisies/déclarées ou
      // issues d'une contribution. Sinon vide (on ne suppose JAMAIS que l'utilisateur parle nge).
      langues: Array.isArray(c.langues) ? c.langues : [],
      contributeur: c,
    }).catch(() => {});
  } catch (e) { /* offline : sans gravité, retenté au prochain enregistrement de profil */ }
}

/** Mot de salutation selon l'HEURE LOCALE de l'appareil (matin/après-midi/soir). */
function hubGreetWord() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return t("hub.greet.morning");
  if (h >= 12 && h < 18) return t("hub.greet.afternoon");
  return t("hub.greet.evening");
}
/** Heure « de veilleur » : connexion en pleine nuit (1h–4h), où l'on est censé dormir. */
function isOwlHour() { const h = new Date().getHours(); return h >= 1 && h <= 4; }
/**
 * Message d'accueil adaptatif : salutation selon l'heure locale + destinataire selon le
 * contexte (prénom si profil, « cher visiteur(rice) » sinon) + clin d'œil « cher veilleur »
 * en pleine nuit. Renvoie le texte complet, emoji compris.
 */
function hubGreeting(nom) {
  const salut = hubGreetWord();
  const owl = isOwlHour();
  if (nom) return owl ? `${salut} ${nom}, ${t("hub.greet.owl")} 👋🏾` : `${salut} ${nom} 👋🏾`;
  return owl ? `${salut} ${t("hub.greet.owl")} 👋🏾` : `${salut} ${t("hub.greet.visitor")} 👋🏾`;
}
/** Écran d'accueil « Que veux-tu faire ? » (profil complet requis). */
function enterHub() {
  // On ne capture le formulaire QUE si l'on arrive de l'écran profil (édition
  // réelle). Au boot / depuis une autre vue, les <select> habillés se synchronisent
  // de façon asynchrone : un collectContributeur() prématuré lirait un champ
  // transitoirement vide et ÉCRASERAIT le profil stocké (rôle, consentement…).
  if (_currentView === "profile") collectContributeur();
  const c = loadContributeur();
  const nom = c.prenom || c.nom || "";
  const greet = hubGreeting(nom);
  const wu = $("#welcome-user"); if (wu) wu.textContent = nom ? greet : "";
  const ht = $("#hub-title");
  if (ht) ht.textContent = greet;
  showView("hub");
  // Reprise d'une réponse à une demande interrompue par une bascule de langue (clic sur une
  // notification « on veut une trad/transcription dans telle langue » → rechargement dans
  // cette langue → on rouvre ici la page de travail avec le mot imposé).
  try { resumePendingRequestAnswer(); } catch (e) { /* jamais bloquant */ }
  // Précharge le corpus (import dynamique de propositions.js, 1,37 Mo) HORS du chemin critique,
  // une fois l'accueil affiché : le premier rendu reste rapide, et le corpus est prêt quand
  // l'utilisateur ouvre Traduire/Transcrire ou quand l'incitation se déclenche.
  idleInit(() => { ensurePropositions().catch(() => {}); }, 1500);
  // Mot du jour (R10) : peuplé en async une fois le corpus prêt (n'impacte pas le 1er rendu).
  idleInit(() => { renderWordOfDay().catch(() => {}); }, 1500);
  // Notifications : rafraîchit la pastille, puis propose un popup si une activité
  // récente concerne l'utilisateur (prioritaire sur l'invitation générique).
  setTimeout(() => { refreshNotifs().then(() => { try { maybeShowNotifPopup(); } catch (e) { /* ok */ } }); }, 1000);
  // Invitation à contribuer (au plus 1×/jour) : apparaît en douceur après l'arrivée.
  setTimeout(() => { try { maybeShowIncitation(); } catch (e) { /* jamais bloquant */ } }, 1400);
  // Invitation à laisser un mot (« Ils parlent de nous ») pour les contributeurs actifs.
  setTimeout(() => { try { maybeInviteTestimonial(); } catch (e) { /* jamais bloquant */ } }, 1800);
  // Les collecteurs ci-dessus ENFILENT leurs popups ; la file les affiche un par un, en alternance,
  // après le délai de grâce (jamais deux à la fois, persistant au rafraîchissement).
  startPopupQueue();
  // Rejoue les déclarations de langue restées en attente (anti-langue-orpheline) : garantit
  // qu'une langue déclarée finit toujours par être enregistrée au backend, même après un échec.
  setTimeout(() => { try { flushPendingLangDecls(); } catch (e) { /* jamais bloquant */ } }, 2200);
  // RECONSTITUTION AUTO en temps réel : à chaque connexion, l'appareil re-déclare ses langues
  // locales pour compléter au backend toute métadonnée manquante (pays, région…), sans écraser.
  setTimeout(() => { try { reconstituteLocalLanguages(); } catch (e) { /* jamais bloquant */ } }, 3000);
  // Aligne les LANGUES D'APPARTENANCE du profil sur les contributions réelles (retire tout
  // défaut hérité type « nge » non parlé, aucune supposition), et pousse la correction au backend.
  setTimeout(() => { try { reconstituteProfileLangues(); } catch (e) { /* jamais bloquant */ } }, 3400);
}
/** Accueil = le hub aux trois portes (Traduire, Transcrire, Explorer). Si le profil
    n'est pas encore complet, l'accueil obligatoire reste la vue Profil (aucun
    contournement de l'onboarding). Branché sur le logo + le nom (header ET footer). */
function goHome() {
  // « Accueil » ramène TOUJOURS au hub (les 4 portes). Le profil (et la langue, qu'il inclut)
  // n'est exigé qu'au moment d'une action qui écrit des données, via requireProfile.
  enterHub();
}

// --- Choix / déclaration de LANGUE (plateforme communautaire) --------------
/** Ouvre l'écran de choix de langue (1er accès + via le sélecteur d'en-tête). */
function openLangChoice() {
  const dc = $("#lang-declare"); if (dc) dc.hidden = true;
  const er = $("#ld-error"); if (er) er.hidden = true;
  renderLangChoice();
  showView("lang");
  // Stats d'enrichissement par langue (nombre de contributions + principaux contributeurs),
  // calculées côté client puis réinjectées sans bloquer l'affichage.
  computeLangStats().then(() => { if (_currentView === "lang") renderLangChoice(); });
}
// { langueCanonique → { count, contrib: {nom: n} } } — degré d'enrichissement par langue.
let _langStats = null;
async function computeLangStats() {
  try {
    const data = await browseLibrary({ limit: 500, device_id: deviceId() });
    const entries = (data && data.entries) || [];
    const by = {};
    for (const e of entries) {
      const lid = canonLangId(entryLang(e));
      if (!lid) continue;
      // On ne compte que les entrées ayant un contenu réel (mot/traduction/audio).
      if (!((e.source_text && e.source_text.trim()) || (e.target_text && e.target_text.trim()) || isPlayable(e.audio_url))) continue;
      const s = by[lid] || (by[lid] = { count: 0, contrib: {} });
      s.count++;
      // Agrégation par PERSONNE (person_id), pas par chaîne de nom : toutes les contributions
      // d'une personne se cumulent, même faites depuis un autre appareil. Le nom public opt-in
      // (credit, dérivé de la personne par le backend) sert d'affichage. (Repli name pré-déploiement.)
      const name = (e.credit || "").trim();   // nom PUBLIC opt-in uniquement (jamais de PII)
      const pid = (e.person_id && String(e.person_id).trim()) || (name ? "n:" + name : "");
      if (pid && name) {
        const c = s.contrib[pid] || (s.contrib[pid] = { name, k: 0 });
        c.k++;
        if (!c.name) c.name = name;
      }
    }
    _langStats = by;
  } catch (e) { _langStats = _langStats || {}; }
}
/** Pastille d'enrichissement + principaux contributeurs d'une langue (HTML sûr, échappé). */
function langStatHtml(id) {
  if (!_langStats) return "";
  const s = _langStats[canonLangId(id)] || { count: 0, contrib: {} };
  const n = s.count;
  const full = n === 0 ? t("lang.contribs.none")
    : (n === 1 ? t("lang.contribs.one") : ti("lang.contribs.many", { n }));
  // Pastille COMPACTE (elle partage la ligne de l'autonyme) : nombre seul quand il y a
  // des contributions, libellé complet en infobulle ; message d'invite si vide. Les
  // principaux contributeurs sont montrés dans Explorer (page de la langue).
  const shown = n === 0 ? full : `🗣 ${n}`;
  return `<span class="lang-count${n ? "" : " lang-count--empty"}" title="${escapeHtml(full)}">${escapeHtml(shown)}</span>`;
}
/** Principaux contributeurs (top 5, avec leur nombre) de la LANGUE COURANTE, depuis les
    entrees d'Explorer. Seuls les noms publics opt-in (credit) sont affiches. HTML sur. */
function topContributorsHtml() {
  // Agrégation par PERSONNE (person_id) : toutes les contributions d'une personne se cumulent,
  // même faites depuis un autre appareil ou d'abord enregistrées sans nom (le backend dérive le
  // credit de la personne canonique = héritage). Repli sur le nom si pas de person_id (pré-déploiement).
  // On inclut AUSSI les contributeurs sans nom public (consentement décoché) : ils apparaissent
  // avec leur nombre sous le libellé « anonyme » (jamais leur nom, on respecte leur choix), pour
  // que le classement reflète TOUS les contributeurs, pas seulement ceux qui ont autorisé leur nom.
  const freq = {};
  let anonSeq = 0;
  for (const e of (_exploreEntries || [])) {
    const name = (e.credit || "").trim();
    // clé de personne : person_id si présent, sinon le nom ; à défaut, chaque entrée anonyme
    // non identifiable compte pour elle-même (repli pré-déploiement, sans person_id ni nom).
    const pid = (e.person_id && String(e.person_id).trim()) || (name ? "n:" + name : "a:" + (anonSeq++));
    const f = freq[pid] || (freq[pid] = { name: "", k: 0 });
    f.k++;
    if (!f.name && name) f.name = name;
  }
  const top = Object.values(freq).sort((a, b) => b.k - a.k).slice(0, 6);
  if (!top.length) return "";
  const list = top.map(({ name, k }) => {
    const label = name ? escapeHtml(name) : `<i>${t("exp.anon")}</i>`;
    return `<span class="exp-contrib-item">${label} <b>${k}</b></span>`;
  }).join("");
  return `<div class="exp-contrib"><span class="exp-contrib-lbl">✍️ ${t("exp.topcontrib")}</span>${list}</div>`;
}
/** Peint la grille des langues connues (graine + déclarées) + la carte « déclarer ». */
/** Libellé de provenance d'une langue = « Région (Pays) ». Règle d'affichage (demande Brice) :
 *  on montre TOUJOURS la région et le pays, en s'adaptant à la saisie de l'utilisateur —
 *  s'il a déjà glissé le pays dans le champ région (ex. « Ouest/Cameroun »), on n'ajoute PAS le
 *  pays entre parenthèses (sinon doublon) ; sinon on l'ajoute. Détection = recherche du nom du
 *  pays dans la région, TOUT EN MINUSCULES (l'utilisateur peut mélanger majuscules/minuscules). */
function langRegionLabel(l) {
  const region = String((getUiLang() === "en" && l.region_en) ? l.region_en : (l.region || "")).trim();
  const pays = String(l.pays || "").trim();
  if (!pays) return region;
  if (!region) return pays;
  return region.toLowerCase().includes(pays.toLowerCase()) ? region : `${region} (${pays})`;
}
function renderLangChoice() {
  const grid = $("#lang-grid");
  if (!grid) return;
  const cur = getCurrentLangId();
  // Les langues fusionnées dans une autre ne s'affichent plus dans la grille (Phase C).
  const cards = visibleLanguages(knownLanguages()).map((l) => {
    const emb = escapeHtml(String(l.id || "?").toUpperCase().slice(0, 3) || "?");   // SIGLE (≤3 lettres)
    const kb = (usesDedicatedKeyboard(l.id) ? t("lang.dedicated") : t("lang.standard"))
      + (l.provisoire ? t("lang.provisoire") : "");
    // Chaîne de recherche normalisée (nom + autonyme + région), sans accents/casse.
    const search = normSearch([l.nom, l.autonyme, l.region].filter(Boolean).join(" "));
    // Agencement compact (gain vertical, crucial sur mobile) : emblème + nom sur la
    // 1re ligne ; autonyme + pastille de contributions partagent la 2e ligne (l'espace
    // horizontal inutilisé), au lieu d'une ligne dédiée à la seule pastille.
    return `<button class="lang-card${l.id === cur ? " is-current" : ""}" type="button" role="listitem" data-lang="${escapeHtml(l.id)}" data-search="${escapeHtml(search)}">
      <span class="lang-head">
        <span class="lang-emblem" aria-hidden="true">${emb}</span>
        <span class="lang-name">${escapeHtml(l.nom)}</span>
      </span>
      <span class="lang-sub">
        ${l.autonyme ? `<span class="lang-autonym">${escapeHtml(l.autonyme)}</span>` : ""}
        ${langStatHtml(l.id)}
      </span>
      ${(() => { const rl = langRegionLabel(l); return rl ? `<span class="lang-region">${escapeHtml(rl)}</span>` : ""; })()}
      <span class="lang-kb">${kb}</span>
    </button>`;
  }).join("");
  // Plus de carte « ➕ » noyée en fin de grille : la déclaration se fait via le
  // bouton distinct EN HAUT (#lang-declare-btn), toujours visible sans défiler.
  grid.innerHTML = cards;
  grid.querySelectorAll(".lang-card[data-lang]").forEach((c) =>
    c.addEventListener("click", () => chooseLang(c.dataset.lang)));
  // Réapplique le filtre courant (utile quand la grille est re-rendue après un
  // chargement distant de langues, sans perdre la recherche en cours).
  const search = $("#lang-search");
  filterLangGrid(search ? search.value : "");
  renderMergePanel();   // Phase C : confirmations en attente + suggestions de doublons
}

/** Panneau de JUMELAGE (Phase C) sur l'écran des langues :
    (1) les confirmations de fusion en attente pour CE contributeur (déclarant concerné),
    (2) les doublons probables détectés automatiquement, à proposer à la fusion. */
async function renderMergePanel() {
  const box = $("#lang-merge-panel");
  if (!box) return;
  const langs = visibleLanguages(knownLanguages());
  // Interpole {a}/{b} dans un libellé i18n en ÉCHAPPANT les noms (données), sans
  // toucher au gabarit (qui contient un <b> voulu).
  const tm = (key, a, b) => t(key).replace("{a}", escapeHtml(a || "?")).replace("{b}", escapeHtml(b || "?"));
  let html = "";

  // (1) Confirmations en attente (les DEUX déclarants doivent valider).
  let pending = [];
  try { pending = await mergesForDevice(deviceId()); } catch (e) { pending = []; }
  for (const m of pending) {
    const pid = escapeHtml(m.id_prop || "");
    html += `<div class="merge-item merge-item--ask">
      <p class="merge-q">${tm("merge.ask", m.nom_a || m.id_a, m.nom_b || m.id_b)}</p>
      <div class="merge-actions">
        <button class="btn btn--next merge-yes" type="button" data-prop="${pid}">${escapeHtml(t("merge.yes"))}</button>
        <button class="chip chip--btn merge-no" type="button" data-prop="${pid}">${escapeHtml(t("merge.no"))}</button>
      </div></div>`;
  }

  // (2) Doublons probables (détection automatique) : proposer la fusion.
  let pairs = [];
  try { pairs = findDuplicatePairs(langs, { minScore: 0.72 }).slice(0, 4); } catch (e) { pairs = []; }
  for (const p of pairs) {
    const pc = pickCanonical(p.a, p.b);
    if (!pc.canonical || !pc.other) continue;
    html += `<div class="merge-item merge-item--sugg">
      <p class="merge-q">${tm("merge.sugg", p.a.nom, p.b.nom)}</p>
      <div class="merge-actions">
        <button class="chip chip--btn merge-propose" type="button"
                data-other="${escapeHtml(pc.other.id)}" data-canon="${escapeHtml(pc.canonical.id)}">${escapeHtml(t("merge.propose"))}</button>
      </div></div>`;
  }

  // (3) Proposition MANUELLE : choisir DEUX langues quelconques et proposer de les
  // réunir (couvre le cas où le moteur ne les a pas rapprochées). Dès 2 langues.
  if (langs.length >= 2) {
    const opts = `<option value="">${escapeHtml(t("merge.manual.pick"))}</option>` +
      langs.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.nom)}</option>`).join("");
    html += `<div class="merge-item merge-item--manual">
      <p class="merge-q">${escapeHtml(t("merge.manual.hint"))}</p>
      <div class="merge-manual-row">
        <select id="merge-sel-a" class="merge-sel" aria-label="${escapeHtml(t("merge.manual.h"))} 1">${opts}</select>
        <select id="merge-sel-b" class="merge-sel" aria-label="${escapeHtml(t("merge.manual.h"))} 2">${opts}</select>
        <button id="merge-manual-go" class="chip chip--btn" type="button">${escapeHtml(t("merge.propose"))}</button>
      </div></div>`;
  }

  box.innerHTML = html;
  box.hidden = !html;
  box.querySelectorAll(".merge-yes").forEach((b) => b.addEventListener("click", () => respondToMerge(b.dataset.prop, "oui")));
  box.querySelectorAll(".merge-no").forEach((b) => b.addEventListener("click", () => respondToMerge(b.dataset.prop, "non")));
  box.querySelectorAll(".merge-propose").forEach((b) => b.addEventListener("click", () => proposeToMerge(b.dataset.other, b.dataset.canon)));
  const go = $("#merge-manual-go");
  if (go) go.addEventListener("click", onManualMerge);
}

/** Proposition MANUELLE : l'utilisateur choisit deux langues et propose de les réunir. */
async function onManualMerge() {
  const a = ($("#merge-sel-a") || {}).value, b = ($("#merge-sel-b") || {}).value;
  if (!a || !b || a === b) { toast(t("merge.same"), "warn"); return; }
  const langs = visibleLanguages(knownLanguages());
  const la = langs.find((l) => l.id === a), lb = langs.find((l) => l.id === b);
  if (!la || !lb) { toast(t("merge.same"), "warn"); return; }
  const pc = pickCanonical(la, lb);
  await proposeToMerge(pc.other.id, pc.canonical.id);
}

async function respondToMerge(pid, valeur) {
  if (!requireProfile("Crée ton profil pour confirmer un jumelage de langues.")) return;
  if (!pid) return;
  let r = null;
  try { r = await respondMerge({ id_prop: pid, device_id: deviceId(), valeur: valeur }); } catch (e) { r = null; }
  if (r && r.ok) {
    toast(valeur === "oui"
      ? (r.statut === "confirmee" ? t("merge.done") : t("merge.pending"))
      : t("merge.distinct"), "ok");
    await refreshLanguagesThenRender();
  } else {
    toast(t("merge.fail"), "warn");
  }
}
async function proposeToMerge(otherId, canonId) {
  if (!requireProfile("Crée ton profil pour proposer un jumelage de langues.")) return;
  if (!otherId || !canonId) return;
  let r = null;
  try { r = await proposeMerge({ id_a: otherId, id_b: canonId, id_canonique: canonId, device_id: deviceId() }); } catch (e) { r = null; }
  if (r && r.ok) {
    toast(r.statut === "confirmee" ? t("merge.done") : t("merge.sent"), "ok");
    await refreshLanguagesThenRender();
  } else {
    toast((r && r.error) ? r.error : t("merge.fail"), "warn");
  }
}
/** Recharge le registre distant (avec l'état de fusion à jour) puis re-rend l'écran. */
async function refreshLanguagesThenRender() {
  try { const list = await fetchLanguages(); if (list) cacheRemoteLanguages(list); } catch (e) { /* hors ligne : sans gravité */ }
  renderLangChoice();
}
/** Normalise pour la recherche : minuscules + sans accents (diacritiques retirés). */
function normSearch(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
/** Filtre les cartes de langue selon la requête ; affiche un message si aucune. */
function filterLangGrid(query) {
  const grid = $("#lang-grid");
  if (!grid) return;
  const q = normSearch(query);
  let visible = 0;
  grid.querySelectorAll(".lang-card[data-lang]").forEach((c) => {
    const match = !q || (c.dataset.search || "").includes(q);
    c.hidden = !match;
    if (match) visible++;
  });
  const empty = $("#lang-empty");
  if (empty) empty.hidden = !(q && visible === 0);
}
/** Ouvre le formulaire de déclaration d'une langue (exige un profil). */
// Le formulaire de déclaration (#lang-declare) est UNIQUE : il vit normalement dans l'écran
// des langues, mais on le DÉPLACE dans le profil quand on y déclare une langue. Aucune
// duplication → tout changement de ses champs se répercute partout (source unique, exigence Brice).
let _declareHome = null;   // { parent, next } : emplacement d'origine, pour le remettre en place
function _captureDeclareHome() {
  const dc = $("#lang-declare"); if (!dc || _declareHome) return;
  _declareHome = { parent: dc.parentNode, next: dc.nextSibling };
}
function restoreDeclareHome() {
  const dc = $("#lang-declare"); if (!dc || !_declareHome) return;
  if (_declareHome.next && _declareHome.next.parentNode === _declareHome.parent)
    _declareHome.parent.insertBefore(dc, _declareHome.next);
  else _declareHome.parent.appendChild(dc);
  dc.hidden = true;
}
/** Déclarer une langue DEPUIS LE PROFIL, en place (sans quitter la page) : on déplace le
    formulaire unique dans le profil. */
function openDeclareInProfile() {
  if (!requireProfile("Termine d'abord les champs obligatoires du profil pour déclarer une langue.")) return;
  _captureDeclareHome();
  _declareCtx = "profile";
  const dc = $("#lang-declare"), host = $("#profile-declare-host");
  if (dc && host) { host.appendChild(dc); dc.hidden = false; dc.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  const n = $("#ld-nom"); if (n) { try { n.focus(); } catch (e) { /* ok */ } }
}
function openDeclareForm() {
  // DÉCLARER une langue exige un profil (contrairement à la simple SÉLECTION).
  if (!requireProfile("Crée ton profil pour pouvoir déclarer une nouvelle langue.")) return;
  _captureDeclareHome(); restoreDeclareHome();   // depuis l'écran des langues : le formulaire est à sa place
  _declareCtx = "lang";
  const dc = $("#lang-declare"); if (dc) dc.hidden = false;
  const n = $("#ld-nom"); if (n) { try { n.focus(); } catch (e) { /* ok */ } }
  if (dc) dc.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
/** Sélectionne une langue → rescope l'app + poursuit vers profil (si incomplet) ou accueil. */
function chooseLang(id) {
  id = canonLangId(id);   // si la langue a été fusionnée, on choisit sa canonique
  setCurrentLangId(id);
  addProfileLangue(id);   // la langue de travail choisie rejoint les langues d'appartenance

  // On RECHARGE : le clavier (dédié à la langue), les libellés, le corpus et le scope
  // Explorer se reconstruisent proprement dans la langue choisie. On vise l'accueil au
  // redémarrage (le routeur, sinon, restaurerait l'écran « langue »). Le verrou de profil
  // reste prioritaire (si le profil est incomplet, l'onboarding s'impose quand même).
  try { history.replaceState(null, "", "#/accueil"); } catch (e) { /* ok */ }
  location.reload();
}
/** Slug d'id de langue à partir du nom, unique dans le registre. */
// ── SIGLE DE LANGUE (≤3 lettres) — critères validés Brice 2026-07-23 ─────────
// 1) code standard ISO 639 si connu (table curée : 639-1 « fr/en », sinon 639-3 « nge/bas… ») ;
// 2) sinon, 3 premières lettres du nom (accents retirés) ; 3) collision → consonnes, puis
// variantes de lettres, puis chiffre ; toujours ≤3 ; 4) figé à la déclaration (stocké dans l'id) ;
// 5) affiché en MAJUSCULES comme pastille. Le nom complet dérive de l'id via _langNameById/le registre.
const LANG_CODE_TABLE = {
  francais: "fr", french: "fr", anglais: "en", english: "en", espagnol: "es", spanish: "es",
  portugais: "pt", portuguese: "pt", arabe: "ar", arabic: "ar",
  ngiemboon: "nge", nguiemboon: "nge", swahili: "swa", kiswahili: "swa",
  bassa: "bas", basaa: "bas", douala: "dua", duala: "dua",
  fulfulde: "ful", "fulfulde peul": "ful", peul: "ful", fula: "ful", fulani: "ful",
  haoussa: "hau", hausa: "hau", ewondo: "ewo", bamoun: "bax", yemba: "ybb",
  ghomala: "bbj", medumba: "byv", fefe: "fmp", feefee: "fmp", nufi: "fmp",
  lingala: "lin", wolof: "wol", yoruba: "yor", igbo: "ibo", zulu: "zul", amharique: "amh", amharic: "amh",
};
function _langNorm(nom) {
  return String(nom || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}
function langCode(nom) {
  const key = String(nom || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  if (LANG_CODE_TABLE[key]) return LANG_CODE_TABLE[key];
  return _langNorm(nom).slice(0, 3) || "lng";
}
/** Sigle ≤3 lettres UNIQUE pour une langue (ISO si connu, sinon dérivé du nom + résolution de
    collision, toujours ≤3). Figé à la déclaration. */
function slugLang(nom) {
  const ids = new Set(knownLanguages().map((l) => String(l.id)));
  const base = langCode(nom);
  if (!ids.has(base)) return base;
  const L = _langNorm(nom), noV = L.replace(/[aeiouy]/g, "");
  const cands = [
    noV.slice(0, 3),                       // consonnes (Bassa → bss)
    (L[0] || "") + noV.slice(0, 2),        // 1re lettre + 2 consonnes
    L.slice(0, 2) + (L[3] || ""),          // lettres 1,2,4
    (L[0] || "") + L.slice(2, 4),          // lettres 1,3,4
  ];
  for (const c of cands) { if (c && c.length >= 2 && c.length <= 3 && !ids.has(c)) return c; }
  const b2 = (base.slice(0, 2) || L.slice(0, 2) || "l");
  for (let i = 2; i <= 9; i++) { const c = b2 + i; if (!ids.has(c)) return c; }
  for (let cc = 97; cc <= 122; cc++) { const c = b2 + String.fromCharCode(cc); if (!ids.has(c)) return c; }
  return base;   // improbable
}
/** POST best-effort de la déclaration au backend (visible par tous). Silencieux si
    le backend n'est pas joignable : la langue reste dispo en local en attendant. */
function declareLanguageRemote(desc) {
  try { declareLanguage(desc).catch(() => {}); } catch (e) { /* offline : sans gravité */ }
}
// --- Déclaration de langue FIABLE (anti-langue-orpheline) -----------------------------
// Une nouvelle langue DOIT finir enregistrée au backend, sinon ses contributions y existent
// mais la langue est invisible dans la liste (bug « dourou »). On persiste toute déclaration
// non confirmée dans une file de RÉESSAI, rejouée à chaque boot jusqu'à succès.
const PENDING_LANGDECL_KEY = "langa-pending-langdecl";
function _pendingLangDecls() {
  try { const a = JSON.parse(localStorage.getItem(PENDING_LANGDECL_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function queuePendingLangDecl(desc) {
  try {
    const arr = _pendingLangDecls().filter((x) => x && x.id !== desc.id);
    arr.push(desc);
    localStorage.setItem(PENDING_LANGDECL_KEY, JSON.stringify(arr));
  } catch (e) { /* stockage indispo */ }
}
/** Rejoue les déclarations de langue en attente (appelé au boot). Retire celles confirmées. */
async function flushPendingLangDecls() {
  const arr = _pendingLangDecls(); if (!arr.length) return;
  const still = [];
  for (const d of arr) {
    try { const r = await declareLanguage(d); if (!r || r.ok === false) still.push(d); }
    catch (e) { still.push(d); }
  }
  try { localStorage.setItem(PENDING_LANGDECL_KEY, JSON.stringify(still)); } catch (e) { /* ok */ }
}
/** Déclare une langue en ATTENDANT la confirmation ; en cas d'échec, met en file de réessai.
    À utiliser AVANT tout location.reload() (sinon le reload avorterait la requête). */
async function declareLanguageReliable(desc) {
  try {
    const r = await declareLanguage(desc);
    if (!r || r.ok === false) queuePendingLangDecl(desc);
  } catch (e) { queuePendingLangDecl(desc); }
}
/** RECONSTITUTION AUTO au démarrage : re-déclare au backend les langues connues LOCALEMENT (elles
    portent les métadonnées complètes saisies par leur déclarant : nom, région, pays, famille),
    afin de COMPLÉTER toute donnée manquante côté base (langue orpheline, pays absent…). Le backend
    ne remplit QUE les champs vides (jamais d'écrasement). Chaque appareil « répare » ainsi ses
    propres langues à chaque connexion, sans rien inventer. Ignore la graine (ngiemboon). */
async function reconstituteLocalLanguages() {
  try {
    const langs = (knownLanguages() || []).filter((l) => l && l.id && !l.graine
      && (l.nom || "").trim() && (l.region || "").trim());
    for (const l of langs) {
      await declareLanguageReliable({
        id: l.id, nom: l.nom, autonyme: l.autonyme || "", region: l.region,
        pays: l.pays || "", famille: l.famille || "", alias: l.alias || [],
        clavier: l.clavier || "defaut", statut: l.statut || "active", device_id: deviceId(),
      });
    }
  } catch (e) { /* jamais bloquant */ }
}
/** RECONSTITUTION des langues d'appartenance depuis les CONTRIBUTIONS LOCALES RÉELLES (aucune
    supposition) : nettoie tout défaut hérité (ex. nge jamais parlé) et aligne le profil sur ce
    que l'utilisateur a VRAIMENT fait. Poussé au backend (l'upsert écrase langues, même vers vide).
    C'est la reconstitution « depuis ses cookies » : on se fonde sur ses vraies données locales. */
async function reconstituteProfileLangues() {
  try {
    const c = loadContributeur();
    if (!c || !c.consentement) return;
    let all = [];
    try { all = await DB.all(); } catch (e) { all = []; }
    const langs = [];
    for (const r of all) {
      const l = canonLangId(r && r.langue);
      if (l && l !== "fr" && !langs.includes(l)) langs.push(l);
    }
    const cur = Array.isArray(c.langues) ? c.langues.map(canonLangId).filter(Boolean) : [];
    const same = cur.length === langs.length && cur.every((x) => langs.includes(x));
    if (same) return;                 // déjà aligné : rien à corriger
    c.langues = langs;
    saveContributeur(c);
    try { renderProfileLangs(); } catch (e) { /* ok */ }
    pushUserProfile();                // pousse la correction au backend (upsert écrase langues)
  } catch (e) { /* jamais bloquant */ }
}
/** Rafraîchit le registre distant des langues (best-effort) puis re-peint si on est
    sur l'écran de choix. */
async function refreshLanguages() {
  try {
    const list = await fetchLanguages();
    if (list) { cacheRemoteLanguages(list); if (_currentView === "lang") renderLangChoice(); }
  } catch (e) { /* sans gravité */ }
}
// --- Anti-doublon : lecture du formulaire + suggestions de langues proches -------
function declareQuery() {
  const v = (s) => (($(s) && $(s).value) || "").trim();
  const alias = v("#ld-alias").split(/[,;/]+/).map((x) => x.trim()).filter(Boolean);
  return { nom: v("#ld-nom"), region: v("#ld-region"), pays: v("#ld-pays"),
           autonyme: v("#ld-autonyme"), alias };
}
let _ldSimTimer = 0;
let _ldConfirmDup = false;
let _reqNlConfirmDup = false;   // même garde anti-doublon pour la déclaration depuis la page Demander
/** Affiche les langues DÉJÀ présentes qui ressemblent à la saisie (pour éviter les
 *  doublons : Nguiemboon / Nguiembor / Nguiembow…). Rendu SÛR (textContent). */
function updateLangSuggestions() {
  const box = $("#ld-similar"); if (!box) return;
  const q = declareQuery();
  box.innerHTML = "";
  if (!q.nom || q.nom.length < 2) { box.hidden = true; return; }
  const hits = findSimilarLanguages(q, knownLanguages(), { limit: 4 });
  if (!hits.length) { box.hidden = true; return; }
  box.hidden = false;
  const head = document.createElement("p");
  head.className = "ld-similar-head";
  head.textContent = t("lang.similar.head");
  box.appendChild(head);
  hits.forEach((h) => {
    const row = document.createElement("div");
    row.className = "ld-similar-row";
    const info = document.createElement("div"); info.className = "ld-similar-info";
    const nm = document.createElement("b"); nm.textContent = h.lang.nom; info.appendChild(nm);
    const meta = [h.lang.region, h.lang.pays].filter(Boolean).join(" · ");
    if (meta) { const m = document.createElement("span"); m.className = "ld-similar-meta"; m.textContent = meta; info.appendChild(m); }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn btn--next ld-similar-pick";
    btn.textContent = t("lang.similar.pick");
    btn.addEventListener("click", () => chooseLang(h.lang.id));
    row.appendChild(info); row.appendChild(btn);
    box.appendChild(row);
  });
  const hint = document.createElement("p");
  hint.className = "ld-similar-hint"; hint.textContent = t("lang.similar.none");
  box.appendChild(hint);
}
function onDeclareInput() {
  _ldConfirmDup = false;                       // toute nouvelle frappe annule la confirmation en attente
  clearTimeout(_ldSimTimer);
  _ldSimTimer = setTimeout(updateLangSuggestions, 220);
}

/** Valide + enregistre une langue déclarée (local immédiat + backend best-effort). */
function submitDeclareLang() {
  if (!requireProfile("Crée ton profil pour pouvoir déclarer une nouvelle langue.")) return;
  const q = declareQuery();
  const nom = q.nom, region = q.region, autonyme = q.autonyme;
  const pays = (($("#ld-pays") && $("#ld-pays").value) || "").trim();
  const famille = (($("#ld-famille") && $("#ld-famille").value) || "").trim();
  const note = ($("#ld-note").value || "").trim();
  const er = $("#ld-error");
  if (!nom || !region || !pays || !famille) {
    if (er) { er.textContent = t("lang.f.req.err"); er.hidden = false; }
    return;
  }
  // Confirmation DOUCE : si une langue très proche existe et qu'on n'a pas encore
  // confirmé, on affiche les suggestions et on demande un 2e clic pour créer quand même.
  const strong = findSimilarLanguages(q, knownLanguages(), { minScore: 0.7, limit: 4 });
  if (strong.length && !_ldConfirmDup) {
    updateLangSuggestions();
    if (er) { er.textContent = t("lang.dup.confirm"); er.hidden = false; }
    _ldConfirmDup = true;
    return;
  }
  _ldConfirmDup = false;
  const id = slugLang(nom);
  const desc = { id, nom, region, pays, autonyme, alias: q.alias, famille, clavier: "defaut", statut: "provisoire" };
  // Création PROVISOIRE : la langue n'existe QUE localement (pour que l'amorce puisse s'y
  // rattacher) ; elle n'est NI déclarée aux autres NI ajoutée aux langues d'appartenance tant
  // que ≥ AMORCE_MIN transcriptions ne sont pas enregistrées (règle Brice : une langue se crée
  // en lui donnant d'abord au moins 5 voix, l'écriture n'étant pas exigée).
  const others = knownLanguages().filter((l) => !l.graine);
  others.push(desc);
  cacheRemoteLanguages(others);
  _amorcePendingNote = note;
  _amorceBuffer = [];
  // reset du formulaire + remise du formulaire à sa place d'origine (il a pu être déplacé dans le profil)
  ["#ld-nom", "#ld-region", "#ld-pays", "#ld-autonyme", "#ld-alias", "#ld-famille", "#ld-note"].forEach((s) => { const e = $(s); if (e) e.value = ""; });
  const box = $("#ld-similar"); if (box) { box.hidden = true; box.innerHTML = ""; }
  if (er) er.hidden = true;
  restoreDeclareHome();
  // Amorce sonore OBLIGATOIRE : la langue ne sera réellement créée qu'après ≥ AMORCE_MIN voix.
  startAmorce(desc);
}

// --- Amorce sonore : premières voix d'une langue nouvellement créée --------
let _amorceLang = null;      // { id, nom, ... } langue en cours d'amorce
let _amorceQueue = [];       // liste de mots (copie de AMORCE)
let _amorceIdx = 0;          // index du mot courant
let _amorceDone = 0;         // nb de mots réellement enregistrés + validés
let _amorceSaved = new Set();// ids déjà enregistrés (évite le double comptage)
let _amRec = null;           // MediaRecorder dédié à l'amorce
let _amChunks = [];
let _amBlob = null;
let _amDur = 0;
let _amStartTs = 0;
// Amorce = les ≥5 transcriptions OBLIGATOIRES qui conditionnent la création d'une langue.
// Tant que le seuil n'est pas atteint, la langue reste PROVISOIRE (locale, non déclarée) et
// les enregistrements sont TAMPONNÉS en mémoire ; à la finalisation on les verse dans la base.
let _amorceBuffer = [];        // enregistrements d'amorce en attente de finalisation
let _amorcePendingNote = "";   // note du formulaire de déclaration, gardée pour la déclaration finale
let _declareCtx = null;        // origine de la déclaration en cours : "profile" | "lang"

function startAmorce(desc) {
  _amorceLang = desc;
  _amorceQueue = AMORCE.slice();
  _amorceIdx = 0;
  _amorceDone = 0;
  _amorceSaved = new Set();
  _amResetRec();
  const g = $("#amorce-goal"); if (g) g.textContent = String(AMORCE_MIN);
  const m = $("#amorce-min"); if (m) m.textContent = String(AMORCE_MIN);
  renderAmorce();
  showView("amorce");
}
function amorceWord() { return _amorceQueue[_amorceIdx] || null; }
function _amResetRec() {
  if (_amRec && _amRec.state !== "inactive") { try { _amRec.stop(); } catch (e) {} }
  _amRec = null; _amChunks = []; _amBlob = null; _amDur = 0;
  const au = $("#amorce-audio"); if (au) { au.hidden = true; try { au.removeAttribute("src"); } catch (e) {} }
  const v = $("#amorce-validate"); if (v) v.disabled = true;
  const btn = $("#amorce-rec-btn"); if (btn) { btn.classList.remove("is-recording"); btn.textContent = t("amorce.rec"); }
  const st = $("#amorce-rec-status"); if (st) st.textContent = "";
}
function renderAmorce() {
  const L = _amorceLang || {};
  const title = $("#amorce-title");
  if (title) title.textContent = `${t("amorce.title.pre")} ${L.nom || ""} 🎙️`.trim();
  const done = $("#amorce-done"); if (done) done.textContent = String(_amorceDone);
  const fill = $("#amorce-bar-fill");
  if (fill) fill.style.width = Math.min(100, Math.round((_amorceDone / AMORCE_MIN) * 100)) + "%";
  const w = amorceWord();
  const fr = $("#amorce-fr"), cat = $("#amorce-cat");
  if (w) {
    if (fr) fr.textContent = w.fr;
    if (cat) cat.textContent = w.cat;
  } else {
    // Toute la liste a été parcourue : on félicite, plus de mot à afficher.
    if (fr) fr.textContent = t("amorce.allwords");
    if (cat) cat.textContent = "";
  }
  const skip = $("#amorce-skip"); if (skip) skip.disabled = !w;
  // Sous le seuil, le bouton ABANDONNE la création (la langue n'existe pas encore) ; au seuil,
  // il CRÉE réellement la langue et se met en avant.
  const fin = $("#amorce-finish");
  if (fin) {
    const ok = _amorceDone >= AMORCE_MIN;
    fin.classList.toggle("btn--go", ok);
    fin.classList.toggle("amorce-stop", !ok);
    fin.textContent = ok ? t("amorce.create") : t("amorce.stoplater");
  }
  _amResetRecUiOnly();
}
function _amResetRecUiOnly() {
  const v = $("#amorce-validate"); if (v) v.disabled = !_amBlob;
}
async function amorceRecToggle() {
  if (_amRec && _amRec.state === "recording") { amorceStopRec(); return; }
  if (!window.isSecureContext) {
    toast(t("toast.audio.https"), "warn");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(t("toast.audio.unsupported"), "warn");
    return;
  }
  try {
    const stream = await acquireMicStream();
    _amChunks = [];
    _amRec = new MediaRecorder(stream);
    _amRec.ondataavailable = (e) => { if (e.data.size) _amChunks.push(e.data); };
    _amRec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      _amBlob = new Blob(_amChunks, { type: _amRec.mimeType || "audio/webm" });
      _amDur = Date.now() - _amStartTs;
      const au = $("#amorce-audio");
      if (au) { try { au.src = URL.createObjectURL(_amBlob); au.hidden = false; } catch (e) {} }
      const st = $("#amorce-rec-status"); if (st) st.textContent = (_amDur / 1000).toFixed(1) + " s ✓";
      const v = $("#amorce-validate"); if (v) v.disabled = false;
    };
    _amStartTs = Date.now();
    _amRec.start();
    const btn = $("#amorce-rec-btn"); if (btn) { btn.classList.add("is-recording"); btn.textContent = t("amorce.rec.stop"); }
    const st = $("#amorce-rec-status"); if (st) st.textContent = t("amorce.rec.wip");
  } catch (e) {
    const msg = e.name === "NotAllowedError" || e.name === "SecurityError"
      ? t("amorce.mic.denied")
      : ti("mic.err.other", { n: e.name });
    toast(msg, "warn");
  }
}
function amorceStopRec() {
  if (_amRec && _amRec.state !== "inactive") { try { _amRec.stop(); } catch (e) {} }
  const btn = $("#amorce-rec-btn"); if (btn) { btn.classList.remove("is-recording"); btn.textContent = t("amorce.rec"); }
}
/** Enregistre l'audio du mot courant comme une contribution (transcription) de la
    nouvelle langue, puis avance. Chaque mot est sauvé DÈS sa validation → l'abandon
    ne perd rien. */
async function amorceValidate() {
  const w = amorceWord();
  if (!w || !_amBlob) return;
  await saveAmorceContribution(_amorceLang.id, w, _amBlob, _amDur);
  if (!_amorceSaved.has(w.id)) { _amorceSaved.add(w.id); _amorceDone++; }
  celebrate($("#amorce-validate"));
  const reached = _amorceDone === AMORCE_MIN;
  _amorceIdx++;
  _amResetRec();
  renderAmorce();
  if (reached) toast(t("amorce.reached"), "ok");
}
function amorceSkip() {
  if (_amRec && _amRec.state === "recording") amorceStopRec();
  _amorceIdx++;
  _amResetRec();
  renderAmorce();
}
function amorceFinish() {
  if (_amRec && _amRec.state === "recording") amorceStopRec();
  const complete = _amorceDone >= AMORCE_MIN;
  if (!complete) {
    // Sous le seuil : on ne jette RIEN. La langue est gardée en « provisoire » (à compléter
    // plus tard) et ce qui a été enregistré est conservé. On confirme simplement l'arrêt.
    const msg = ti("amorce.stop.confirm", { n: _amorceDone, min: AMORCE_MIN, lang: (_amorceLang && _amorceLang.nom) || "" });
    if (!window.confirm(msg)) return;
  }
  _amorceEnd(complete);
}
/** Fin de l'amorce : on VERSE toujours dans la base ce qui a été enregistré (jamais jeté) et on
    garde la langue. Complète (≥ AMORCE_MIN) → statut « active » ; sinon → « provisoire » (la langue
    existe et pourra être complétée plus tard, par son auteur ou par d'autres locuteurs). */
async function _amorceEnd(complete) {
  const desc = _amorceLang; if (!desc) return;
  for (const rec of _amorceBuffer) { try { await DB.put(rec); markDoneText(rec.source_text); } catch (e) { /* ignore */ } }
  const statut = complete ? "active" : "provisoire";
  const others = knownLanguages().filter((l) => !l.graine).map((l) => l.id === desc.id ? Object.assign({}, l, { statut }) : l);
  cacheRemoteLanguages(others);
  // Déclaration FIABLE : on ATTEND sa confirmation AVANT le reload plus bas (sinon le reload
  // avorterait la requête et la langue resterait orpheline). En cas d'échec, file de réessai.
  await declareLanguageReliable(Object.assign({ note: _amorcePendingNote || "" }, desc, { statut }));
  addProfileLangue(desc.id);            // la langue (même provisoire) devient une langue d'appartenance
  _amorceBuffer = []; _amorcePendingNote = "";
  try { kickReconcile(); } catch (e) { /* le boot renverra de toute façon */ }
  // La langue devient la langue courante ; on recharge pour tout reconstruire (corpus, clavier,
  // Explorer). Retour au profil si la déclaration en venait, sinon l'accueil.
  setCurrentLangId(desc.id);
  const target = _declareCtx === "profile" ? "#/profil" : "#/accueil";
  _declareCtx = null;
  try { history.replaceState(null, "", target); } catch (e) { /* ok */ }
  location.reload();
}
async function saveAmorceContribution(langId, word, blob, durMs) {
  const c = loadContributeur();
  const rec = {
    client_id: (crypto.randomUUID && crypto.randomUUID()) || "c-" + Date.now() + "-" + word.id,
    direction: "fr2" + langId,
    langue: langId,
    source_lang: "fr",
    target_lang: langId,
    source_text: word.fr,
    target_text: "",
    domaine: "amorce",
    note: "",
    amorce_id: word.id,
    contributeur: c,
    consentement: !!c.consentement,
    device_id: deviceId(),
    created_at: new Date().toISOString(),
    status: "local",
    audioBlob: blob || null,
    audioMeta: blob ? { present: true, format: (blob && blob.type) || "audio/webm", duree_ms: durMs } : { present: false },
  };
  // On NE PERSISTE PAS encore : tant que le seuil de ≥ AMORCE_MIN n'est pas atteint, la langue
  // est provisoire. Les enregistrements sont tamponnés en mémoire, versés dans la base à la
  // finalisation (_amorceFinalize) ou jetés à l'abandon (_amorceAbort). Rien n'est envoyé au
  // backend pour une langue qui pourrait être abandonnée.
  _amorceBuffer = _amorceBuffer.filter((r) => r.amorce_id !== rec.amorce_id);   // remplace si on refait le même mot
  _amorceBuffer.push(rec);
}
/** Configure l'espace de travail selon l'activité (Traduire / Transcrire). */
// --- Consignes par activité (Transcrire / Traduire), affichées les 3 premières fois ---
const GUIDE_MAX = 3;
function showGuide(act) {
  const g = $("#tr-guide"), card = $("#tr-guide-card"); if (!g || !card) return;
  card.dataset.show = act === "translate" ? "translate" : "transcribe";
  g.hidden = false;
  const ok = $("#tr-guide-ok"); if (ok) { try { ok.focus(); } catch (e) { /* ok */ } }
}
function hideGuide() { const g = $("#tr-guide"); if (g) g.hidden = true; }
/** Affiche les consignes de l'activité les GUIDE_MAX premières fois (compteur par appareil). */
function maybeShowGuide(act) {
  const key = "langa-guide-count-" + (act === "translate" ? "translate" : "transcribe");
  let n = parseInt(localStorage.getItem(key) || "0", 10);
  if (!isFinite(n)) n = 0;
  if (n >= GUIDE_MAX) return;
  localStorage.setItem(key, String(n + 1));
  showGuide(act);
}
function setActivity(act) {
  const next = act === "transcribe" ? "transcribe" : "translate";
  const changed = next !== activity;
  activity = next;
  // Changer d'espace = nouvelle tâche → on ne traîne PAS un audio/texte non
  // enregistré de l'espace précédent (sinon il se collerait à la contribution
  // suivante). N'efface rien à l'initialisation (activité inchangée).
  if (changed) discardWorkingInputs();
  localStorage.setItem("activity", activity);
  const va = $("#view-app"); if (va) va.dataset.act = activity;
  const isT = activity === "transcribe";
  const t2 = $("#work-title"); if (t2) t2.textContent = isT ? t("work.title.transcribe") : t("work.title.translate");
  const wico = $("#work-ico"); if (wico) wico.src = isT ? "icons/mic-real.png" : "icons/act-translate.svg";
  updateWorkLang();   // rappel FORT de la langue de contribution (anti-mauvais étiquetage)
  const bimg = $("#work-banner-img"); if (bimg) bimg.src = isT ? "icons/banner-transcribe.jpg" : "icons/banner-translate.jpg";
  const beye = $("#work-banner-eye"); if (beye) beye.textContent = isT ? t("pb.transcribe.eye") : t("pb.translate.eye");
  const btit = $("#work-banner-title"); if (btit) btit.textContent = isT ? t("pb.transcribe.title") : t("pb.translate.title");
  const h = $("#work-help");
  if (h) h.innerHTML = isT ? t("work.help.transcribe") : t("work.help.translate");
  const la = $("#lbl-audio"); if (la) la.textContent = isT ? t("work.audio.transcribe") : t("work.audio.translate");
  const pl = $("#prop-cat-label"); if (pl) pl.textContent = isT ? t("work.propcat.transcribe") : t("work.propcat.translate");
  const tl = $("#lbl-target"); if (tl) tl.textContent = isT ? t("work.lbltarget.transcribe") : t("work.lbltarget.translate");
  const tp = $("#tab-traduire"); if (tp) tp.classList.toggle("is-active", !isT);
  const tt = $("#tab-transcrire"); if (tt) tt.classList.toggle("is-active", isT);
  const te = $("#tab-explorer"); if (te) te.classList.remove("is-active");
  applyOptionalSections(activity);   // replie la section OPTIONNELLE selon l'activité
  updateGate();
}
/** Différencie Traduire et Transcrire : la contribution SECONDAIRE est repliée derrière un
    bouton « Ajouter … » (non supprimée). En Transcrire, la traduction est optionnelle ; en
    Traduire, la transcription audio est optionnelle. L'utilisateur peut la déplier à tout moment
    pour compléter son mot (faire les deux). */
function applyOptionalSections(act) {
  const isT = act === "transcribe";
  const tw = $("#target-wrap"), aw = $("#audio-wrap");
  const addT = $("#add-translation"), addA = $("#add-transcription");
  if (tw) tw.hidden = isT;          // traduction repliée en Transcrire
  if (addT) addT.hidden = !isT;     // bouton « Ajouter une traduction » (Transcrire)
  if (aw) aw.hidden = !isT;         // audio replié en Traduire
  if (addA) addA.hidden = isT;      // bouton « Ajouter une transcription audio » (Traduire)
}
/** Déplie une section optionnelle et masque son bouton d'ajout (l'utilisateur a choisi de la remplir). */
function _revealOptional(zoneSel, btnSel, focusSel) {
  const z = $(zoneSel), btn = $(btnSel);
  if (z) z.hidden = false;
  if (btn) btn.hidden = true;
  if (focusSel) { const f = $(focusSel); if (f) keepScroll(() => { try { f.focus({ preventScroll: true }); } catch (e) { /* ok */ } }); }
}
async function enterWork(act, forceMode) {
  if (!requireProfile(act === "transcribe"
    ? "Crée ton profil pour enregistrer des prononciations."
    : "Crée ton profil pour proposer des traductions.")) return;
  if (isKbOpen()) hideKeyboard();
  mode = forceMode || "proposer";   // PAR DÉFAUT « se faire proposer un mot » (Brice) ; « libre » seulement
                                    // pour les entrées spéciales (réponse à une demande, « dis-le dans ta langue »).
  setActivity(act);
  await ensurePropositions();   // le corpus (import dynamique) doit être prêt avant de proposer un mot
  initPropCategories();         // (re)peuple le sélecteur de groupes maintenant que le corpus est chargé
  applyMode();   // applique le mode (affiche la barre de proposition + propose un mot si « proposer »)
  refreshDoneTexts();   // liste des mots déjà faits par l'utilisateur (pour la détection de doublon en mode libre)
  // Consignes de l'activité, affichées les 3 premières fois (Transcrire ET Traduire).
  maybeShowGuide(act);
  // Rétablit la cible du clavier sur le champ de la langue courante (elle a pu être
  // reciblée vers un champ d'Explorer). Seulement si la langue a un clavier DÉDIÉ ;
  // sinon on rend la main au clavier système (pas d'inputmode=none).
  const nge = ngeField();
  if (usesDedicatedKeyboard(getCurrentLangId())) {
    if (keyboard) keyboard.setTarget(nge);
    _kbField = nge;
  } else {
    if (nge) nge.removeAttribute("inputmode");
    _kbField = null;
  }
  showView("app");
  refreshReqStrip(act);   // lot 5 : demandes de la communauté dans SA langue à traiter ici
}

// --- LOT 5 « Demander » : bandeau des demandes de la communauté à traiter -----
// Les demandes ouvertes DANS LA LANGUE de l'utilisateur apparaissent en haut de
// Traduire/Transcrire. Un clic charge le mot demandé en source ; la réponse
// devient une contribution reliée à la demande (compte comme réponse + notifie le
// demandeur). On ne montre que les demandes pertinentes pour l'activité courante.
let _reqStripItems = [];
function _reqMatchesActivity(kind, act) {
  if (act === "transcribe") return kind === "transcription" || kind === "les_deux";
  return kind === "traduction" || kind === "les_deux";   // translate
}
async function refreshReqStrip(act) {
  const strip = $("#req-strip"), list = $("#req-strip-list");
  if (!strip || !list) return;
  act = act || activity;
  let data = null;
  try { data = await fetchRequestsToTranslate(deviceId()); } catch (e) { data = null; }
  const items = ((data && data.items) || []).filter((r) => _reqMatchesActivity(r.kind, act));
  _reqStripItems = items;
  if (!items.length) { strip.hidden = true; list.innerHTML = ""; return; }
  list.innerHTML = items.map(reqStripChipHtml).join("");
  strip.hidden = false;
}
function reqStripChipHtml(r) {
  const label = (getUiLang() === "en" && r.texte_en) ? r.texte_en : r.texte;
  const by = (r.credit || "").trim();
  return `<button type="button" class="req-chip" role="listitem" data-rid="${escapeHtml(r.id)}"` +
    ` title="${escapeHtml(by ? ti("reqx.by", { who: by }) : t("reqx.chip.title"))}">` +
    `<span class="req-chip-word">${escapeHtml(label)}</span>` +
    (r.note ? `<span class="req-chip-note">${escapeHtml(r.note)}</span>` : "") +
    `</button>`;
}
function onReqStripClick(e) {
  const btn = e.target.closest && e.target.closest(".req-chip");
  if (!btn) return;
  const item = _reqStripItems.find((x) => x.id === btn.dataset.rid);
  if (item) loadRequestIntoSource(item);
}
/** Charge le mot d'une demande comme SOURCE à traiter (traduire/prononcer). La
    source est imposée (comme un item proposé) ; on retient l'id de la demande pour
    relier la contribution. */
function loadRequestIntoSource(item) {
  mode = "libre"; applyMode();                         // source libre (on va la fixer nous-mêmes)
  if (direction !== "fr2nge") { direction = "fr2nge"; applyDirection(); }
  currentProp = null;
  _currentReqId = item.id;
  const src = $("#source");
  if (src) {
    src.dataset.canon = item.texte;                    // canonique FR (cohérence Explorer, #48)
    src.value = (getUiLang() === "en" && item.texte_en) ? item.texte_en : sourceDisplay(item.texte);
    src.readOnly = true;                               // mot imposé par la demande
    src.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // Même page (clic sur une demande du bandeau) → aucun déplacement du défilement.
  const tg = $("#target");
  if (tg && activity !== "transcribe") { tg.value = ""; keepScroll(() => { try { tg.focus({ preventScroll: true }); } catch (e) { /* ok */ } }); }
  toast(ti("reqx.loaded", { w: item.texte }), "ok");
}
/** #53 — « Dis-le dans ta langue » : depuis une entrée, propose le MÊME mot français dans la
    langue de l'utilisateur. Redirige vers profil (si absent), écran des langues (si aucune choisie),
    sinon ouvre Traduire en mode libre pré-rempli. Nouveau canal : regarder ce qu'ont fait les
    autres, puis le refaire dans sa langue. */
async function startTranslateWord(frWord) {
  const w = shareClean(frWord, 200);
  if (!w) return;
  if (!requireProfile(t("req.profile.translate"))) return;   // pas de profil → l'ouvre d'abord
  if (!hasChosenLang()) { openLangChoice(); return; }         // pas de langue → écran des langues
  await enterWork("translate", "libre");                      // « libre » : on va imposer le mot nous-mêmes.
  // IMPORTANT : on ATTEND enterWork (async : await ensurePropositions puis applyMode qui VIDE la source
  // en mode libre). Sans await, on posait le mot puis applyMode l'effaçait → case vide (bug popup).
  if (direction !== "fr2nge") { direction = "fr2nge"; applyDirection(); }
  const s = $("#source");
  if (s) { delete s.dataset.canon; s.value = w; s.readOnly = false; s.dispatchEvent(new Event("input", { bubbles: true })); }
  // Nouvelle page ouverte en haut (le mot pré-rempli est visible) : focus SANS re-scroll.
  const tg = $("#target"); if (tg) { tg.value = ""; setTimeout(() => { try { tg.focus({ preventScroll: true }); } catch (e) { tg.focus(); } }, 60); }
  toast(ti("saymine.toast", { w }), "ok");
}
/** Ouvre Explorer sur un mot précis (via lien direct) pour que l'utilisateur NOTE
    les propositions (juste / doute / faux). Utilisé par l'incitation « rate ». */
function startRateWord(frWord, dir) {
  const w = shareClean(frWord, 200);
  if (!w) return;
  if (!requireProfile(t("req.profile.explore"))) return;
  if (!hasChosenLang()) { openLangChoice(); return; }
  try { history.pushState({ v: "explore" }, "", "#/explorer?w=" + encodeURIComponent(w) + "&d=" + encodeURIComponent(dir || "fr2nge")); } catch (e) { /* ok */ }
  enterExplore();   // capte le lien direct puis ouvre le détail du mot (avec les pastilles de vote)
}

// --- Incitation à contribuer (nudge personnalisé) ---------------------------
// Moteur UNIQUE (réutilisable plus tard pour l'envoi d'e-mails via langial.com) :
// choisit un mot que l'utilisateur n'a PAS encore fait dans sa langue et, si
// possible, s'appuie sur ce qu'un AUTRE contributeur a déjà partagé (référence
// sociale) pour l'inviter à le dire à son tour.
// FRÉQUENCE : au plus 3×/jour, sur 3 CRÉNEAUX de la journée LOCALE de la personne
// (l'heure de l'APPAREIL = l'heure de son pays) : matin (~9 h), après-midi (~15 h),
// soir (~20 h). Au plus une apparition PAR CRÉNEAU, à la 1re ouverture de l'app dans
// ce créneau (un PWA ne s'exécute pas en fond pour surgir pile à l'heure : le
// déclenchement horaire précis 9 h/15 h/20 h sera le rôle des e-mails, à venir).
const INCITE_KEY = "langa-incite-slots";
function _incTodayStr() { try { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); } catch (e) { return ""; } }
/** Créneau courant selon l'HEURE LOCALE (fuseau de l'appareil/pays), ou null la nuit. */
function _incSlot() {
  let h; try { h = new Date().getHours(); } catch (e) { h = 12; }
  if (h >= 5 && h < 12) return "am";      // matin (~9 h)
  if (h >= 12 && h < 18) return "pm";     // après-midi (~15 h)
  if (h >= 18 && h < 24) return "eve";    // soir (~20 h)
  return null;                            // nuit profonde (0 h–5 h) : aucune incitation
}
function _incShownSlots() {
  try { const o = JSON.parse(localStorage.getItem(INCITE_KEY) || "{}");
    return (o && o.date === _incTodayStr() && Array.isArray(o.slots)) ? o.slots : []; } catch (e) { return []; }
}
// ===== FILE d'attente des popups : JAMAIS deux à la fois =====================
// Les popups (invitation à contribuer, à noter, demande de la communauté…) n'apparaissent
// jamais simultanément. Ils entrent dans une file et s'ALTERNENT : chacun s'affiche
// ~POPUP_ROTATE_MS, puis cède la place au suivant, en boucle, jusqu'à ce que l'utilisateur
// clique une ACTION (le popup quitte alors définitivement la file). « Plus tard »/fermer =
// retrait de la file pour cette session (il revient au prochain chargement). Persistant au
// rafraîchissement : après un refresh, on attend POPUP_GRACE_MS avant la 1re apparition.
const POPUP_ROTATE_MS = 60000;   // 1 min par popup avant de passer au suivant
const POPUP_GRACE_MS = 18000;    // délai après (re)chargement avant la 1re apparition
let _pq = [];                    // [{ id, show }]
let _pqIdx = 0, _pqTimer = 0, _pqCurrent = null, _pqStarted = false;
function _pqHideAllEls() {
  const inc = $("#incite-banner"); if (inc) inc.hidden = true;
  const np = $("#notif-popup"); if (np) np.hidden = true;
  _incStopAudio();
}
function _pqShow() {
  if (!_pq.length) { _pqCurrent = null; _pqHideAllEls(); return; }
  _pqIdx = ((_pqIdx % _pq.length) + _pq.length) % _pq.length;
  const item = _pq[_pqIdx];
  _pqHideAllEls();
  try { item.show(); _pqCurrent = item.id; } catch (e) { _pqCurrent = null; }
}
function _pqAdvance() { if (_pq.length) { _pqIdx++; _pqShow(); } }
function _pqRestartTimer() {
  clearInterval(_pqTimer); _pqTimer = 0;
  if (_pq.length > 1) _pqTimer = setInterval(_pqAdvance, POPUP_ROTATE_MS);
}
/** Enfile un popup (sans doublon d'id). `show` rend + affiche l'élément quand son tour vient. */
function enqueuePopup(id, show) {
  if (_pq.some((x) => x.id === id)) return;
  _pq.push({ id, show });
  if (_pqStarted) { if (_pq.length === 1) _pqShow(); _pqRestartTimer(); }
}
/** Retire un popup de la file (session). Si c'était l'actuel, on affiche le suivant. */
function dismissPopup(id) {
  const wasCurrent = _pqCurrent === id;
  const before = _pq.length;
  _pq = _pq.filter((x) => x.id !== id);
  if (_pq.length === before) { if (wasCurrent) _pqHideAllEls(); return; }
  if (!_pq.length) { clearInterval(_pqTimer); _pqTimer = 0; _pqCurrent = null; _pqHideAllEls(); return; }
  if (wasCurrent) { if (_pqIdx >= _pq.length) _pqIdx = 0; _pqShow(); }
  _pqRestartTimer();
}
/** Démarre la rotation APRÈS le délai de grâce (appelé une fois, au chargement). */
function startPopupQueue() {
  if (_pqStarted) return;
  setTimeout(() => { _pqStarted = true; if (_pq.length) { _pqShow(); _pqRestartTimer(); } }, POPUP_GRACE_MS);
}
/** Illustration ronde d'un popup : la personne ENTIÈRE (contain) sur un fond FLOUTÉ (la même
    image agrandie et floutée comble les parties vides/transparentes). */
function _popIllHTML(file) {
  const u = "icons/" + file;
  return '<span class="pop-ill">' +
    '<img class="pop-ill-bg" src="' + u + '" alt="" aria-hidden="true">' +
    '<img class="pop-photo" src="' + u + '" alt="" aria-hidden="true">' +
    "</span>";
}

function incitationDue() {
  // Inviter à contribuer ne demande qu'une langue choisie + consentement ; le profil complet
  // (téléphone…) est revérifié au CLIC (startTranslateWord/startRateWord → requireProfile).
  const c = loadContributeur();
  if (!hasChosenLang() || !c.consentement) return false;
  const slot = _incSlot(); if (!slot) return false;
  return !_incShownSlots().includes(slot);
}
function _incMarkShown() {
  const slot = _incSlot(); if (!slot) return;
  try {
    const slots = _incShownSlots();
    if (!slots.includes(slot)) slots.push(slot);
    localStorage.setItem(INCITE_KEY, JSON.stringify({ date: _incTodayStr(), slots }));
  } catch (e) { /* stockage indispo */ }
}
function _incLangName(id) {
  const l = knownLanguages().find((x) => canonLangId(x.id) === canonLangId(id));
  return l ? l.nom : "";
}
/** Cherche, dans la langue de l'utilisateur, une proposition d'un AUTRE qu'il n'a
    pas encore notée : on l'incitera à donner son avis (juste / doute / faux). But :
    faire monter la qualité des données par la notation communautaire. */
async function pickRateCandidate() {
  try {
    const data = await browseLibrary({ limit: 300, device_id: deviceId() });
    const mine = canonLangId(getCurrentLangId());
    const myCredit = creditDisplay();
    const cands = (((data && data.entries) || [])).filter((e) => {
      if (canonLangId(entryLang(e)) !== mine) return false;      // sa langue uniquement
      if ((e.my_vote || "") !== "") return false;                // pas déjà noté par lui
      if (!(e.target_text || "").trim()) return false;           // rien d'écrit à juger
      if (myCredit && (e.credit || "").trim() === myCredit) return false;  // pas sa propre contribution
      return true;
    });
    if (!cands.length) return null;
    const e = cands[Math.floor(Math.random() * cands.length)];
    return { kind: "rate", word: (e.source_text || "").trim(),
             target: (e.target_text || "").trim(), dir: dirCanon(e) };
  } catch (e) { return null; }
}
/** Choisit un item non fait (mots d'abord, puis phrases) + une référence sociale
    optionnelle (contribution d'un AUTRE, dans une autre langue) sur ce même item ;
    OU, une fois sur deux, incite à NOTER une proposition non encore jugée. */
async function pickIncitation() {
  // Environ une fois sur deux : inviter à noter plutôt qu'à traduire (qualité des données).
  if (Math.random() < 0.5) {
    const r = await pickRateCandidate();
    if (r && r.word) return r;
  }
  await refreshDoneTexts();
  let undone = groupUndone("mots");
  if (undone.length < 20) undone = undone.concat(groupUndone("phrases"));
  if (!undone.length) {
    const r = await pickRateCandidate();   // plus rien à traduire → on propose de noter
    return (r && r.word) ? r : null;
  }
  let chosen = null, ref = null;
  try {
    const data = await browseLibrary({ limit: 300 });
    const mine = canonLangId(getCurrentLangId());
    const byNorm = new Map(undone.map((it) => [it.norm || normTxt(it.texte), it]));
    for (const e of (((data && data.entries) || []))) {
      const src = (e.source_text || "").trim(); if (!src) continue;
      const it = byNorm.get(normTxt(src)); if (!it) continue;
      const elang = canonLangId(entryLang(e));
      if (elang === mine) continue;               // on met en avant ce qu'un AUTRE a fait, ailleurs
      const aud = isPlayable(e.audio_url) ? e.audio_url : null;
      const cand = { name: (e.credit || "").trim() || null, langId: elang, audio: aud, audioDur: e.audio_duree_ms || 0 };
      if (!ref) { chosen = it; ref = cand; }      // 1re correspondance…
      if (aud) { chosen = it; ref = cand; break; } // …mais on PRÉFÈRE une contribution AVEC audio (écoutable)
    }
  } catch (e) { /* hors ligne : pas de référence, on garde un mot non fait */ }
  if (!chosen) chosen = undone[Math.floor(Math.random() * undone.length)];
  return { kind: "translate", word: chosen.texte, ref };
}
function renderIncitation(pick) {
  const bn = $("#incite-banner"); if (!bn || !pick) return;
  // Type visuel du popup (couleur + icône) : « rate » = évaluer/voter (or), sinon
  // « contribute » = on t'invite à donner un mot dans ta langue (vert). Voir CSS data-ptype.
  const _setIco = (e) => { const i = bn.querySelector(".incite-ico"); if (i) i.textContent = e; };
  // Illustration RONDE (personne entière, contain) sur fond flouté, selon le type.
  const _setImg = (file) => { const i = bn.querySelector(".incite-ico"); if (i) i.innerHTML = _popIllHTML(file); };
  const w = pick.word;                                  // mot CANONIQUE (français) pour l'action
  // BUG corrigé : en mode anglais, on AFFICHE le mot dans la langue de l'interface
  // (jamais de mot français à un anglophone). `wordInUiLang` interroge d'abord la base
  // (corpus source_en), puis le cache DeepL déjà résolu ; sinon repli sûr.
  const wShow = pick.wordUi || wordInUiLang(w);
  const langName = (currentLang() && currentLang().nom) || "";
  const go = $("#incite-go"), lis = $("#incite-listen");
  // Variante « noter » : on invite à donner son avis sur une proposition non jugée.
  if (pick.kind === "rate") {
    bn.dataset.ptype = "rate"; _setImg("pop-rate-ill.webp");
    const m = $("#incite-msg"); if (m) m.innerHTML = ti("incite.rate.msg", { w: kw("word", wShow, true), lang: kw("lang", langName, true) });
    if (lis) { lis.hidden = true; lis.onclick = null; }
    if (go) { go.textContent = t("incite.rate.cta"); go.onclick = () => { _incMarkShown(); _incStopAudio(); bn.hidden = true; dismissPopup("incite"); startRateWord(pick.word, pick.dir); }; }
    bn.hidden = false;
    return;
  }
  bn.dataset.ptype = "contribute"; _setImg("pop-contribute-ill.webp");
  if (go) go.textContent = t("incite.cta");   // rétablit le libellé « traduire » (peut avoir été changé)
  let text;
  // Dès qu'une VOIX est proposée (bouton écouter), on donne sa PROVENANCE : soit le nom de la
  // personne, soit « quelqu'un » (anonyme) + la LANGUE dans laquelle elle l'a dit. Puis on invite
  // à le dire dans SA propre langue. Sans voix ni référence, message générique.
  const wKw = kw("word", wShow, true);   // mot demandé mis en évidence (gabarits déjà « … »)
  if (pick.ref && (pick.ref.name || pick.ref.audio)) {
    const ln = pick.ref.langId ? _incLangName(pick.ref.langId) : "";
    const inlang = ln ? ti("incite.inlang", { l: kw("lang", ln, true) }) : "";   // « en {langue} » seulement si connue
    text = pick.ref.name
      ? ti("incite.msg.ref", { w: wKw, name: kw("who", pick.ref.name, true), inlang })
      : ti("incite.msg.refanon", { w: wKw, inlang });
  } else {
    text = ti("incite.msg", { w: wKw, lang: kw("lang", langName, true) });
  }
  const msg = $("#incite-msg"); if (msg) msg.innerHTML = text;   // mots clés en évidence ; valeurs échappées par kw()
  if (go) go.onclick = () => { _incMarkShown(); _incStopAudio(); bn.hidden = true; dismissPopup("incite"); startTranslateWord(w); };
  // Bouton « Écouter » : on peut entendre la version d'un AUTRE (dans sa langue) avant de la
  // dire dans la sienne. Affiché seulement si la contribution de référence a un audio jouable.
  if (lis) {
    const aud = pick.ref && pick.ref.audio;
    lis.hidden = !aud;
    if (aud) {
      lis.textContent = pick.ref.name ? ti("incite.listen.name", { name: pick.ref.name }) : t("incite.listen");
      lis.dataset.label = lis.textContent;      // libellé de référence (restauré après écoute)
      lis.disabled = false; lis.classList.remove("is-loading", "is-playing");
      lis.onclick = () => _incPlayAudio(aud);
    } else { lis.onclick = null; }
  }
  bn.hidden = false;
}
function _incStopAudio() { const au = $("#incite-audio"); if (au) { try { au.pause(); au.currentTime = 0; } catch (e) { /* ok */ } } }
/** Joue l'audio d'une contribution (direct/data ou Drive) dans le petit lecteur du popup. */
async function _incPlayAudio(url) {
  const au = $("#incite-audio"), lis = $("#incite-listen");
  if (!au || !url) return;
  // Retour visuel sur le bouton « Écouter » (comme dans Explorer) : l'audio Drive a une latence
  // de téléchargement → sans indicateur, on croit que le bouton bugue. On montre « Chargement… »
  // puis « Lecture… », et on restaure le libellé à la fin.
  const label = lis ? (lis.dataset.label || lis.textContent) : "";
  if (lis) lis.dataset.label = label;
  const restore = () => { if (!lis) return; lis.disabled = false; lis.classList.remove("is-loading", "is-playing"); lis.textContent = lis.dataset.label || t("incite.listen"); };
  const setStatus = (msg) => { if (lis && msg) lis.textContent = msg; };
  try { au.pause(); } catch (e) { /* ok */ }
  if (lis) { lis.disabled = true; lis.classList.add("is-loading"); lis.textContent = t("audio.loading"); }
  const did = driveFileId(url);
  try {
    if (did) { await loadDriveAudioInto(au, did, setStatus); }
    else { au.src = url; au.load(); }
  } catch (e) { /* on tente quand même la lecture */ }
  try {
    await au.play();
    if (lis) { lis.disabled = false; lis.classList.remove("is-loading"); lis.classList.add("is-playing"); lis.textContent = t("audio.playing"); }
  } catch (e) { restore(); return; }   // politique autoplay : le clic utilisateur devrait suffire
  au.onended = restore; au.onpause = restore; au.onerror = restore;
}
// « Plus tard »/fermer : retrait de la FILE pour cette session (il reviendra au prochain
// chargement, après le délai de grâce). On ne marque PAS « vu » : seul un clic d'ACTION le retire
// définitivement (comportement demandé : les popups persistent tant qu'on ne les a pas actionnés).
function _incDismiss() { _incStopAudio(); const bn = $("#incite-banner"); if (bn) bn.hidden = true; dismissPopup("incite"); }
/** À appeler quand on arrive sur l'accueil : ENFILE l'invitation si elle est due (la file l'affiche). */
async function maybeShowIncitation() {
  if (!incitationDue()) return;
  try { await ensurePropositions(); } catch (e) { return; }   // corpus requis (import dynamique) avant de choisir un mot
  let pick = null; try { pick = await pickIncitation(); } catch (e) { pick = null; }
  if (!pick || !incitationDue()) return;          // re-vérifie après l'await (course éventuelle)
  // Résout l'équivalent dans la langue de l'UI AVANT d'afficher (jamais de FR à un anglophone).
  try { pick.wordUi = await resolveWordUi(pick.word); } catch (e) { /* repli sync */ }
  enqueuePopup("incite", () => renderIncitation(pick));   // jamais deux popups à la fois : la file gère
}

// --- MOT DU JOUR (R10) -------------------------------------------------------
// Un mot du corpus, choisi de façon DÉTERMINISTE par la date : le MÊME pour tout le
// monde ce jour-là, et il change chaque jour (habitude/rétention). Invite à le dire
// dans sa langue (réutilise startTranslateWord). Peuplé en ASYNC (le corpus est en
// import dynamique) → n'impacte pas la vitesse d'affichage de l'accueil.
function _dayIndex() { try { return Math.floor(Date.now() / 86400000); } catch (e) { return 0; } }
async function renderWordOfDay() {
  const host = $("#word-of-day"), wEl = $("#wod-word"), cta = $("#wod-cta");
  if (!host || !wEl) return;
  try { await ensurePropositions(); } catch (e) { host.hidden = true; return; }
  const mots = groupItems("mots");
  if (!mots.length) { host.hidden = true; return; }
  const fr = mots[_dayIndex() % mots.length].texte;
  let show = fr;
  try { show = wordInUiLang(fr) || fr; } catch (e) { /* repli FR */ }
  wEl.textContent = show;
  if (cta) cta.onclick = () => startTranslateWord(fr);
  host.hidden = false;
}

// --- Notifications : centre horodaté + pastille de non-lues + popup --------
// Les notifications viennent du backend (fetchNotifications). L'état « lu » est
// LOCAL : on mémorise l'horodatage (ms) de la dernière consultation ; toute
// notification plus récente est « non lue ». Aucune PII : l'acteur n'est nommé
// que par son crédit d'affichage DÉJÀ consenti (sinon « une personne »).
const NOTIF_SEEN_KEY = "langa-notif-seen";
const NOTIF_POPUP_KEY = "langa-notif-popup";   // dernier ts pour lequel un popup a été montré
let _popupNotif = null;                        // notif actuellement montrée en popup (pour « Ouvrir »)
let _notifs = [];
let _notifsReturn = "hub";

/** Crédit d'affichage (prénom/sigle) si l'utilisateur l'a autorisé, sinon "". */
function creditDisplay() {
  try { return String(loadContributeur().credit_display || "").trim(); } catch (e) { return ""; }
}
function _notifSeenTs() { const v = parseInt(localStorage.getItem(NOTIF_SEEN_KEY) || "0", 10); return v > 0 ? v : 0; }
function _setNotifSeenTs(ts) { try { localStorage.setItem(NOTIF_SEEN_KEY, String(ts || 0)); } catch (e) { /* ok */ } }

// ── LECTURE PAR NOTIFICATION (correctif) ────────────────────────────────────
// Le compteur = nombre de NON LUES, où « lue » est un état PAR notification (pas un simple
// horodatage). Ouvrir la page ne marque plus tout lu : une notif passe en clair (lue) quand on
// LA lit (clic) ou via « Tout marquer comme lu ». Ensemble d'ids lus persisté (borné à 1000).
const NOTIF_READ_KEY = "langa-notif-read";
let _notifReadCache = null;
function _notifKey(n) { return String((n && (n.id || (String(n.type || "") + ":" + (n.ts || 0)))) || ""); }
function _notifReadSet() {
  if (!_notifReadCache) { try { _notifReadCache = new Set(JSON.parse(localStorage.getItem(NOTIF_READ_KEY) || "[]")); } catch (e) { _notifReadCache = new Set(); } }
  return _notifReadCache;
}
function _saveNotifRead(set) {
  let arr = [...set]; if (arr.length > 1000) arr = arr.slice(-1000);
  _notifReadCache = new Set(arr);
  try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify(arr)); } catch (e) { /* quota */ }
}
function _isNotifRead(n) { return _notifReadSet().has(_notifKey(n)); }
function _markNotifRead(n) { const s = _notifReadSet(); const k = _notifKey(n); if (k && !s.has(k)) { s.add(k); _saveNotifRead(s); } }
function notifUnreadCount() { return _notifs.filter((n) => !_isNotifRead(n)).length; }

/** Récupère les notifications + met à jour la pastille (silencieux, à l'ouverture). */
async function refreshNotifs() {
  if (!profileComplete()) return;
  let data = null;
  try { data = await fetchNotifications(deviceId(), _notifSeenTs()); } catch (e) { data = null; }
  if (!data) return;
  _notifs = data.notifications || [];
  updateNotifBadge(notifUnreadCount());   // non lues = celles jamais lues (état par notification)
}
function updateNotifBadge(n) {
  const b = $("#notif-badge"); if (!b) return;
  if (n > 0) { b.textContent = n > 99 ? "99+" : String(n); b.hidden = false; }
  else b.hidden = true;
}
/** Message lisible d'une notification (construit en TEXTE → anti-injection). */
/** Enveloppe un mot clé de popup (nom du demandeur, mot demandé, langue cible) : en gras
    + couleur dédiée quand `html` est vrai (mise en évidence), sinon texte brut (aria/listes
    accessibles). Le texte utilisateur est TOUJOURS échappé. */
function kw(cls, s, html) { return html ? '<b class="kw kw-' + cls + '">' + escapeHtml(s) + "</b>" : s; }
/** Message d'une notification. `html=true` → mots clés mis en évidence (gras + couleur),
    mot demandé entre guillemets ; `html=false` → texte brut sûr (aria-label, comparaisons). */
function notifText(n, html) {
  const d = n.data || {};
  const whoRaw = (d.actor || "").trim() || t("notif.someone");
  const who = kw("who", whoRaw, html);
  const rawMot = (d.mot || d.texte || "").trim();
  // ADAPTATIF : le mot est affiché dans la langue du DESTINATAIRE. En anglais on
  // préfère l'équivalent fourni par le backend (base d'abord, sinon DeepL mémorisé),
  // sinon la base locale ; en français, le mot d'origine.
  const motEn = (d.mot_en || d.texte_en || "").trim();
  const motTxt = (getUiLang() === "en") ? (motEn || wordInUiLang(rawMot)) : rawMot;
  const motW = (s) => kw("word", s, html);      // les gabarits portent déjà « … » : on ne fait que colorer/mettre en gras
  const ln = d.langue ? _incLangName(d.langue) : "";
  if (n.type === "vote") {
    const kindK = { ok: "notif.kind.ok", doubt: "notif.kind.doubt", no: "notif.kind.no" }[d.kind] || "notif.kind.ok";
    return ti("notif.vote", { who, mot: motTxt ? motW(motTxt) : kw("word", t("notif.your"), html), kind: kw("kind", t(kindK), html) });
  }
  if (n.type === "suggestion") return ti("notif.sugg", { who, mot: motTxt ? motW(motTxt) : kw("word", t("notif.your"), html) });
  if (n.type === "milestone") return ti("notif.milestone", { lang: kw("lang", ln || t("notif.yourlang"), html), count: kw("num", String(d.count || 0), html) });
  if (n.type === "request" || n.type === "request_share") {
    // Sens PRÉCIS selon la nature de la demande : traduction, prononciation, ou les deux.
    const act = d.kind === "transcription" ? t("notif.req.act.transc")
      : d.kind === "les_deux" ? t("notif.req.act.both") : t("notif.req.act.trad");
    const lang = ln || _langNameById(d.langue) || t("notif.yourlang");
    return ti(n.type === "request" ? "notif.request" : "notif.request_share", { who, act, mot: motW(motTxt || "…"), lang: kw("lang", lang, html) });
  }
  if (n.type === "request_answered") return ti("notif.request_answered", { who, mot: motTxt ? motW(motTxt) : kw("word", t("notif.your"), html) });
  return html ? escapeHtml(String(d.text || "")) : String(d.text || "");   // announce / types futurs
}
/** Libellé du bouton d'action d'un popup de notification : indique la DESTINATION réelle du
    clic (traduire/transcrire dans la langue demandée, voir la réponse, la bibliothèque…),
    pour ne pas laisser croire qu'on ouvre « mes notifications ». */
function notifPopupCta(n) {
  const d = n.data || {};
  const lang = (d.langue ? (_incLangName(d.langue) || _langNameById(d.langue)) : "") || t("notif.yourlang");
  if (n.type === "request") {
    const key = d.kind === "transcription" ? "notif.cta.transc" : d.kind === "les_deux" ? "notif.cta.both" : "notif.cta.trad";
    return ti(key, { lang });
  }
  if (n.type === "request_share") return t("notif.cta.relay");
  if (n.type === "request_answered") return t("notif.cta.answer");
  if (n.type === "vote" || n.type === "suggestion") return t("notif.cta.see_entry");
  if (n.type === "milestone") return t("notif.cta.see_lib");
  return t("notif.see");
}
function notifIcon(type) {
  // Icônes africaines fournies (fond transparent) à la place des émojis génériques.
  const f = ({ vote: "ni-vote", suggestion: "ni-suggestion", milestone: "ni-milestone", announce: "ni-announce",
    request: "ni-request", request_share: "ni-share", request_answered: "ni-answered" })[type] || "ni-default";
  return '<img class="notif-ico-img" src="icons/' + f + '.png" alt="" aria-hidden="true">';
}
function relTime(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t("notif.now");
  const m = Math.floor(s / 60); if (m < 60) return ti("notif.min", { n: m });
  const h = Math.floor(m / 60); if (h < 24) return ti("notif.hour", { n: h });
  const j = Math.floor(h / 24); if (j < 7) return ti("notif.day", { n: j });
  try { return new Date(ts).toLocaleDateString(getUiLang() === "en" ? "en-GB" : "fr-FR"); } catch (e) { return ""; }
}
/** Une notification est ACTIONNABLE si un clic mène quelque part d'utile. Presque toutes
    le sont : le système sert d'INTERMÉDIAIRE entre utilisateurs, chaque notification
    ouvre le bon endroit pour agir ou voir le résultat. */
function notifActionable(n) {
  return ["request", "request_share", "request_answered", "vote", "suggestion", "milestone"].includes(n.type);
}
function notifItemHtml(n) {
  const unread = !_isNotifRead(n);   // état de lecture PAR notification (plus un simple horodatage)
  const d = n.data || {};
  const act = notifActionable(n);
  const mot = (d.mot || d.texte || "").toString();
  const data = `data-ntype="${escapeHtml(n.type)}" data-reqid="${escapeHtml(d.req_id || "")}"` +
    ` data-mot="${escapeHtml(mot)}" data-moten="${escapeHtml(d.texte_en || d.mot_en || "")}"` +
    ` data-lang="${escapeHtml(d.langue || "")}" data-kind="${escapeHtml(d.kind || "")}" data-nkey="${escapeHtml(_notifKey(n))}"`;
  return `<li class="notif ${unread ? "notif--unread" : ""}${act ? " notif--action" : ""}"` +
    ` role="button" tabindex="0" aria-label="${escapeHtml(notifText(n))}"` + ` ${data}>` +
    `<span class="notif-ico" aria-hidden="true">${notifIcon(n.type)}</span>` +
    `<div class="notif-body"><p class="notif-msg">${notifText(n, true)}</p>` +
    `<span class="notif-time">${escapeHtml(relTime(n.ts))}</span></div>` +
    (act ? `<span class="notif-go" aria-hidden="true">→</span>` : "") + `</li>`;
}
/** Clic sur une notification du CENTRE : reconstruit la donnée depuis le DOM et route. */
function onNotifAction(li) {
  // 1) marque CETTE notification comme lue (état par notif) → ligne en clair + pastille décrémentée.
  const k = li.dataset.nkey;
  if (k) { const s = _notifReadSet(); if (!s.has(k)) { s.add(k); _saveNotifRead(s); } }
  li.classList.remove("notif--unread");
  updateNotifBadge(notifUnreadCount());
  // 2) si elle est actionnable, on emmène l'utilisateur là où agir.
  if (li.classList.contains("notif--action")) {
    routeNotif(li.dataset.ntype, {
      req_id: li.dataset.reqid, mot: li.dataset.mot, texte: li.dataset.mot,
      texte_en: li.dataset.moten, langue: li.dataset.lang, kind: li.dataset.kind,
    });
  }
}
/** ROUTEUR de notification — le cœur de l'intermédiation entre utilisateurs. Selon la
    nature de la notification, on emmène l'utilisateur EXACTEMENT là où agir :
    - request          : quelqu'un demande une trad/transcription DANS SA langue
                         → page Traduire ou Transcrire, mot pré-rempli, réponse reliée à
                           la demande (le backend notifie ensuite le demandeur).
    - request_share    : demande dans une langue qu'il ne parle pas → page Demander pour RELAYER.
    - request_answered : sa demande a reçu une réponse → le mot dans Explorer (voir/écouter).
    - vote / suggestion: retour sur SA contribution → le mot dans Explorer.
    - milestone        : cap franchi dans sa langue → Explorer (sa langue). */
function routeNotif(type, d) {
  d = d || {};
  if (type === "request") { startRequestAnswer(d); return; }
  if (type === "request_share") { enterDemander(d.req_id || null); return; }   // relayer/partager
  const mot = (d.mot || d.texte || "").toString();
  if (mot && type !== "milestone") { location.hash = "#/explorer?w=" + encodeURIComponent(mot); return; }
  location.hash = "#/explorer";   // milestone (ou sans mot) → bibliothèque de sa langue
}
/** Démarre la RÉPONSE à une demande depuis une notification : ouvre la bonne page
    (Traduire/Transcrire) avec le mot imposé, en se plaçant sur la langue de la demande.
    Si l'utilisateur ne parle pas cette langue, il est dirigé vers Demander pour relayer.
    Robuste au multi-langue : si un changement de langue courante est nécessaire, la demande
    est mémorisée et reprise automatiquement après le rechargement. */
function startRequestAnswer(d) {
  const langue = canonLangId(d.langue || "");
  const item = { id: d.req_id || "", texte: (d.texte || d.mot || "").toString(),
    texte_en: (d.texte_en || "").toString(), kind: d.kind || "traduction", langue };
  if (!item.id || !item.texte) { enterDemander(item.id || null); return; }   // repli : page Demander
  if (!requireProfile(t("req.needprofile"))) return;
  const known = !langue || knownLanguages().some((l) => canonLangId(l.id) === langue);
  if (langue && !known) { enterDemander(item.id); return; }   // pas locuteur → relayer la demande
  if (langue && canonLangId(getCurrentLangId()) !== langue) {
    // bascule nécessaire vers la langue de la demande : on mémorise puis on recharge
    try { sessionStorage.setItem(PENDING_REQ_KEY, JSON.stringify(item)); } catch (e) { /* ok */ }
    chooseLang(langue);   // recharge l'app dans la bonne langue (reprise via resumePendingRequestAnswer)
    return;
  }
  _openWorkForRequest(item);
}
const PENDING_REQ_KEY = "langa-pending-req";
async function _openWorkForRequest(item) {
  const act = (item.kind === "transcription" || item.kind === "les_deux") ? "transcribe" : "translate";
  await enterWork(act, "libre");   // ATTENDRE enterWork (async) : sa fin appelle applyMode qui VIDE la source ;
  loadRequestIntoSource(item);     // on charge le mot APRÈS, sinon il est effacé (bug popup notif « demande »).
}
/** Au démarrage : si une réponse à une demande était en attente d'un changement de langue,
    on la reprend automatiquement une fois l'app rechargée dans la bonne langue. */
function resumePendingRequestAnswer() {
  let raw = null;
  try { raw = sessionStorage.getItem(PENDING_REQ_KEY); sessionStorage.removeItem(PENDING_REQ_KEY); } catch (e) { return; }
  if (!raw) return;
  let item = null; try { item = JSON.parse(raw); } catch (e) { return; }
  if (item && item.id && item.texte && canonLangId(getCurrentLangId()) === canonLangId(item.langue || "")) {
    _openWorkForRequest(item);
  }
}
async function renderNotifs() {
  const feed = $("#notif-feed"), empty = $("#notif-empty");
  // 1) rendu INSTANTANÉ depuis ce qu'on a déjà en mémoire (refreshNotifs au boot/intervalle
  //    a déjà chargé TOUTES les notifs ; `since` ne filtre pas, il ne marque que les non-lues).
  const paint = () => { if (feed) feed.innerHTML = _notifs.map(notifItemHtml).join(""); if (empty) empty.hidden = _notifs.length > 0; };
  paint();
  // 2) revalidation réseau en arrière-plan → met à jour l'affichage si quelque chose a changé.
  let data = null;
  try { data = await fetchNotifications(deviceId(), 0); } catch (e) { data = null; }
  if (data) { _notifs = data.notifications || []; paint(); }
}
/** Tout marquer comme lu = mémoriser l'horodatage courant (les suivantes seront « non lues »). */
/** « Tout marquer comme lu » (bouton) : marque TOUTES les notifications chargées comme lues. */
function markNotifsRead() {
  const s = _notifReadSet();
  _notifs.forEach((n) => { const k = _notifKey(n); if (k) s.add(k); });
  _saveNotifRead(s);
  updateNotifBadge(0);
  const feed = $("#notif-feed"); if (feed) feed.querySelectorAll(".notif--unread").forEach((el) => el.classList.remove("notif--unread"));
}
function openNotifs() {
  if (_currentView !== "notifs") _notifsReturn = _currentView;
  showView("notifs");
  renderNotifs();   // n'auto-marque PLUS tout lu : les non lues restent en évidence jusqu'à lecture réelle.
}
/** Popup à l'ouverture s'il y a une notif personnelle fraîche jamais encore montrée en popup. */
async function maybeShowNotifPopup() {
  if (!profileBasics()) return;   // informer d'une activité sur son travail n'exige pas le téléphone
  const seen = _notifSeenTs();
  const lastPop = parseInt(localStorage.getItem(NOTIF_POPUP_KEY) || "0", 10) || 0;
  const POP_TYPES = { vote: 1, suggestion: 1, milestone: 1, request: 1, request_answered: 1 };
  const fresh = _notifs.filter((n) => POP_TYPES[n.type]
    && (n.ts || 0) > seen && (n.ts || 0) > lastPop && !_isNotifRead(n));   // jamais un popup pour une notif déjà lue
  if (!fresh.length) return;
  const n = fresh[0];   // la plus récente (liste triée décroissante)
  enqueuePopup("notif", () => _renderNotifPopup(n));   // jamais deux popups à la fois : la file gère
}
/** Rendu + affichage du popup de notification (appelé par la file quand son tour vient). */
function _renderNotifPopup(n) {
  const pop = $("#notif-popup"), msg = $("#notif-popup-msg");
  if (!pop || !msg) return;
  _popupNotif = n;      // mémorisée pour que « Ouvrir » agisse selon son type
  msg.innerHTML = notifText(n, true);   // mots clés (nom, mot « … », langue) mis en évidence
  const go = $("#notif-popup-go"); if (go) go.textContent = notifPopupCta(n);   // libellé = destination réelle
  // Couleur + icône selon le TYPE : « request » = une demande de la communauté (cyan),
  // sinon « activity » = un retour sur TES contributions (violet). Voir CSS data-ptype.
  const isReq = (n.type === "request" || n.type === "request_answered");
  const isMile = (n.type === "milestone");
  pop.dataset.ptype = isMile ? "rate" : (isReq ? "request" : "activity");   // jalon = teinte or (célébration)
  const _ico = pop.querySelector(".incite-ico");
  // Illustrations RONDES (contain) sur fond flouté : jalon = badge de célébration (illustration
  // fournie) ; demande = appel à la communauté ; activité = deux personnes qui échangent. NB : on
  // utilise hub-request-ill (illustration TRANSPARENTE, ~44 % de vide) et non pop-request-ill qui est
  // OPAQUE (le fond blanc flouté ne transparaissait pas → frost absent sur ce seul popup, cf. bug #68).
  const _img = isMile ? "milestone-badge.webp" : (isReq ? "hub-request-ill.webp" : "two-talk-ill.webp");
  if (_ico) _ico.innerHTML = _popIllHTML(_img);
  pop.hidden = false;
}
// « Plus tard »/fermer : retrait de la file pour cette session (revient au prochain chargement).
function _notifPopupClose() { const p = $("#notif-popup"); if (p) p.hidden = true; dismissPopup("notif"); }

// --- Porte « Demander » : entraide communautaire de traduction/transcription --
// Un utilisateur demande un mot/phrase dans une langue précise ; les locuteurs sont
// notifiés (« viens aider »), les autres invités à relayer. N'importe qui répond en
// place (texte) : la réponse devient une contribution qui alimente Explorer et
// prévient le demandeur. Backend : ops request / answer_request (sync.js).
let _reqReturn = "hub";
let _requests = [];
function _langNameById(id) {
  const l = knownLanguages().find((x) => canonLangId(x.id) === canonLangId(id));
  return l ? l.nom : String(id || "");
}
function _fillReqLangSelects() {
  const langs = visibleLanguages(knownLanguages());
  const opts = langs.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.nom)}</option>`).join("");
  const sel = $("#req-langue");
  if (sel) {
    const prev = sel.value;   // préserve un choix déjà fait (ex. après déclaration d'une langue)
    // Aucune valeur par défaut : l'utilisateur DOIT choisir lui-même.
    // « Déclarer une nouvelle langue » en tête (déclaration LÉGÈRE, sans amorce,
    // car le demandeur n'est pas forcément locuteur), avant la liste des langues.
    sel.innerHTML =
      `<option value="" disabled${prev ? "" : " selected"}>${escapeHtml(t("req.langue.choose"))}</option>` +
      `<option value="__new__">➕ ${escapeHtml(t("req.newlang.opt"))}</option>` +
      opts;
    sel.value = prev || "";
  }
  const f = $("#req-filter-lang");
  if (f) { const cur = f.value; f.innerHTML = `<option value="">${escapeHtml(t("req.filter.all"))}</option>` + opts; f.value = cur || ""; }
  refreshEnhancedSelects();
}
function _onReqLangueChange() {
  const sel = $("#req-langue"), box = $("#req-newlang");
  if (!sel || !box) return;
  box.hidden = sel.value !== "__new__";
  if (!box.hidden) { const n = $("#req-nl-nom"); if (n) n.focus(); }
}
// Même règle que slugLang (sigle ISO/≤3 lettres, unique) pour la déclaration légère (porte Demander).
function _slugLang(nom) { return slugLang(nom); }
/** Déclaration LÉGÈRE d'une langue depuis la porte Demander : enregistre la langue
    (nom, région, pays) SANS amorce, l'ajoute au registre local, et la sélectionne. */
async function _declareNewLangForRequest() {
  const nom = ($("#req-nl-nom").value || "").trim();
  const region = ($("#req-nl-region").value || "").trim();
  const pays = ($("#req-nl-pays").value || "").trim();
  const err = $("#req-nl-error");
  if (!nom || !region) { if (err) { err.hidden = false; err.textContent = t("req.newlang.err"); } return; }
  const known = knownLanguages();
  // HARMONISATION avec le formulaire principal (submitDeclareLang) : même garde ANTI-DOUBLON.
  // Si une langue déjà connue ressemble fortement à la saisie, on invite à la CHOISIR dans la
  // liste plutôt que d'en créer une en double ; un 2e clic force la création malgré tout.
  const strong = findSimilarLanguages({ nom, region, pays, autonyme: "", alias: [] }, known, { minScore: 0.7, limit: 3 });
  if (strong.length && !_reqNlConfirmDup) {
    if (err) { err.hidden = false; err.textContent = ti("req.newlang.dup", { noms: strong.map((s) => s.lang.nom).join(", ") }); }
    _reqNlConfirmDup = true;
    return;
  }
  _reqNlConfirmDup = false;
  if (err) err.hidden = true;
  let id = _slugLang(nom);
  // évite une collision d'id (suffixe incrémental)
  let base = id, k = 2; while (known.some((l) => l.id === id)) { id = base + k; k++; }
  const rec = { id, nom, region, pays, autonyme: "", alias: [], famille: "", clavier: "defaut", statut: "active" };
  const btn = $("#req-nl-declare"); if (btn) btn.disabled = true;
  try {
    declareLanguageReliable({ id, nom, region, pays, device_id: deviceId() });   // fiable (file de réessai si échec)
    addKnownLanguage(rec);                                                     // registre local immédiat
    _fillReqLangSelects();
    const sel = $("#req-langue"); if (sel) { sel.value = id; refreshEnhancedSelects(); }
    _onReqLangueChange();
    $("#req-nl-nom").value = ""; $("#req-nl-region").value = ""; $("#req-nl-pays").value = "";
    toast(ti("req.newlang.ok", { nom }), "ok");
  } catch (e) { toast(t("req.fail"), "warn"); }
  finally { if (btn) btn.disabled = false; }
}
async function enterDemander(targetReqId) {
  if (!requireProfile(t("req.needprofile"))) return;
  if (_currentView !== "demander") _reqReturn = _currentView;
  _fillReqLangSelects();
  // Venant d'une notification ciblant une demande précise : on lève le filtre de langue
  // pour être certain que la demande visée figure dans la liste.
  if (targetReqId) { const f = $("#req-filter-lang"); if (f) { f.value = ""; refreshEnhancedSelects(); } }
  showView("demander");
  await renderRequests();
  if (targetReqId) _openRequestAnswer(targetReqId);
}
/** Ouvre (déplie) la boîte de réponse d'une demande précise et l'amène à l'écran. */
function _openRequestAnswer(rid) {
  const list = $("#req-list"); if (!list || !rid) return;
  const esc = (window.CSS && CSS.escape) ? CSS.escape(rid) : rid.replace(/["\\]/g, "\\$&");
  const item = list.querySelector(`.req-item[data-id="${esc}"]`);
  if (!item) { toast(t("req.gone"), "warn"); return; }   // demande résolue/retirée entre-temps
  item.scrollIntoView({ behavior: "smooth", block: "center" });
  const box = item.querySelector(".req-answer-box");
  if (box && box.hidden) {
    box.hidden = false;
    const inp = box.querySelector(".req-answer-input"); if (inp) inp.focus({ preventScroll: true });
  }
  item.classList.add("req-item--flash");
  setTimeout(() => item.classList.remove("req-item--flash"), 1700);
}
function reqKindLabel(k) {
  return t({ traduction: "req.kind.trad.s", transcription: "req.kind.transc.s", les_deux: "req.kind.both.s" }[k] || "req.kind.trad.s");
}
function reqCardHtml(r) {
  const lang = _langNameById(r.langue);
  const who = (r.credit || "").trim();
  const loc = [r.pays, r.region, r.variante].filter(Boolean).map((x) => x).join(" · ");
  const meta = [reqKindLabel(r.kind), lang, loc].filter(Boolean).join(" · ");
  return `<li class="req-item${r.mine ? " req-item--mine" : ""}" data-id="${escapeHtml(r.id)}" data-w="${escapeHtml(r.texte)}" data-lang="${escapeHtml(r.langue)}">` +
    `<div class="req-top"><span class="req-word">${escapeHtml(r.texte)}</span>` +
      `<span class="req-badge">${escapeHtml(lang)}</span></div>` +
    `<div class="req-meta">${escapeHtml(meta)}${who ? " · " + escapeHtml(ti("req.by", { who })) : ""}</div>` +
    (r.note ? `<div class="req-note">${escapeHtml(r.note)}</div>` : "") +
    `<div class="req-actions">` +
      (r.mine ? `<span class="req-mine-tag">${escapeHtml(t("req.mine"))}</span>`
              : `<button type="button" class="btn btn--sm req-answer-open">${escapeHtml(t("req.answer"))}</button>`) +
      `<button type="button" class="chip chip--btn req-share">${escapeHtml(t("req.share"))}</button>` +
      `<span class="req-count">${escapeHtml(ti("req.answers", { n: r.answers || 0 }))}</span>` +
    `</div>` +
    `<div class="req-answer-box" hidden>` +
      `<input type="text" class="req-answer-input" maxlength="280" placeholder="${escapeHtml(t("req.answer.ph"))}" />` +
      `<button type="button" class="btn btn--primary btn--sm req-answer-send">${escapeHtml(t("req.answer.send"))}</button>` +
    `</div>` +
  `</li>`;
}
async function renderRequests() {
  const list = $("#req-list"), empty = $("#req-empty");
  const flt = ($("#req-filter-lang") && $("#req-filter-lang").value) || "";
  let data = null;
  try { data = await fetchRequests(flt, deviceId()); } catch (e) { data = null; }
  _requests = (data && data.requests) || [];
  if (list) list.innerHTML = _requests.map(reqCardHtml).join("");
  if (empty) empty.hidden = _requests.length > 0;
}
async function submitRequest() {
  if (!requireProfile(t("req.needprofile"))) return;   // écrire une demande = profil exigé
  const texte = ($("#req-texte").value || "").trim();
  const langue = ($("#req-langue").value || "").trim();
  const kind = ($("#req-kind").value || "").trim();
  const err = $("#req-error");
  if (langue === "__new__") { if (err) { err.hidden = false; err.textContent = t("req.newlang.first"); } return; }
  if (!texte || !langue || !kind) { if (err) { err.hidden = false; err.textContent = t("req.err.fields"); } return; }
  if (err) err.hidden = true;
  const btn = $("#req-send"); if (btn) btn.disabled = true;
  try {
    const r = await postRequest({
      texte, langue, lang_nom: _langNameById(langue), kind,
      pays: ($("#req-pays").value || "").trim(), note: ($("#req-note").value || "").trim(),
      device_id: deviceId(), credit: creditDisplay(),
    });
    if (r && r.ok) {
      toast(t("req.sent"), "ok");
      $("#req-texte").value = ""; $("#req-pays").value = ""; $("#req-note").value = "";
      renderRequests();
    } else { toast(t("req.fail"), "warn"); }
  } catch (e) { toast(t("req.fail"), "warn"); }
  finally { if (btn) btn.disabled = false; }
}
async function _sendAnswer(item, btn) {
  const inp = item.querySelector(".req-answer-input");
  const texte = ((inp && inp.value) || "").trim();
  if (!texte) { toast(t("req.answer.empty"), "warn"); return; }
  const rid = item.dataset.id;
  if (btn) btn.disabled = true;
  try {
    const c = loadContributeur();
    const r = await postAnswer({
      request_id: rid, texte, device_id: deviceId(),
      credit_display: c.credit_display || "", contributeur: c,
      client_id: "ans-" + rid + "-" + deviceId(),
    });
    if (r && r.ok) { toast(t("req.answer.ok"), "ok"); renderRequests(); }
    else { toast(t("req.fail"), "warn"); }
  } catch (e) { toast(t("req.fail"), "warn"); }
  finally { if (btn) btn.disabled = false; }
}
/** Message prêt à copier/partager pour relayer une demande (non-locuteurs). */
async function _shareRequest(item) {
  const w = item.dataset.w, lang = _langNameById(item.dataset.lang);
  const url = PRESENT_URL.replace(/\/$/, "");
  const ctx = { w, lang };
  openSharePanel(url, "request", ctx);   // panneau réseaux (texte propre à chaque plateforme), tous supports
}
function onReqListClick(e) {
  const openB = e.target.closest(".req-answer-open");
  if (openB) {
    const box = openB.closest(".req-item").querySelector(".req-answer-box");
    if (box) { box.hidden = !box.hidden; const inp = box.querySelector(".req-answer-input"); if (!box.hidden && inp) inp.focus(); }
    return;
  }
  const share = e.target.closest(".req-share");
  if (share) { _shareRequest(share.closest(".req-item")); return; }
  const send = e.target.closest(".req-answer-send");
  if (send) { _sendAnswer(send.closest(".req-item"), send); return; }
}

function enterExplore() {
  // Capture le lien direct AVANT que showView n'aligne l'URL sur « #/explorer » (sans requête).
  const w = hashParam("w"); if (w) { _deepWord = w; _deepDir = hashParam("d"); }
  // Explorer = LECTURE seule, ouvert à tous SANS profil. Les ACTIONS qui écrivent (voter,
  // proposer une amélioration) restent verrouillées par requireProfile dans leurs handlers.
  ["#tab-traduire", "#tab-transcrire"].forEach((s) => { const el = $(s); if (el) el.classList.remove("is-active"); });
  const te = $("#tab-explorer"); if (te) te.classList.add("is-active");
  showView("explore");
  loadLibrary();
}

// --- Visite guidée (pédagogie : projecteur + bulles « Étape N sur N ») -----
// ─── Visite guidée : contenu de l'aide ────────────────────────────────────
// Principe : l'aide n'ÉCHO PAS l'étiquette à l'écran ; elle apporte le POURQUOI,
// les conséquences, les astuces et ce qu'on peut vraiment faire. Chaque vue reçoit
// son contenu propre PLUS un socle partagé (identité, barre d'outils du header,
// navigation, pied de page) : ainsi absolument chaque élément visible est indexé.
// Le filtre de visibilité (startTour) écarte à l'exécution ce qui n'est pas affiché.
// Style : pas de point final, pas de tiret cadratin baladeur ; « ↔ » autorisé.

// Identité, présentée en ouverture de chaque visite. Chaque étape porte sa traduction
// anglaise (`en:`) ; le rendu (tourGoto) choisit selon la langue d'interface.
const TOUR_INTRO = [
  { sel: ".brand", title: "LANGIAL, en deux mots", text: "Cette application rassemble les mots et les voix de nos langues pour en bâtir des dictionnaires, des claviers et des intelligences artificielles. Touche ce logo ou ce nom à tout moment pour revenir à l'accueil et ses trois portes : Traduire, Transcrire, Explorer",
    en: { title: "LANGIAL in a nutshell", text: "This app gathers the words and voices of our languages to build dictionaries, keyboards and artificial intelligences from them. Tap this logo or name at any time to go back to the home screen and its three doors: Translate, Transcribe, Explore" } },
];
// Barre d'outils du header, disponible sur toutes les pages.
const TOUR_TOOLS = [
  { sel: "#net", title: "Tes voyants d'état", text: "Ici se lisent ta connexion et le lien avec la base, puis le nombre de contributions déjà rassemblées par toute la communauté. Hors connexion rien n'est perdu : tout est gardé sur l'appareil et repart tout seul dès que le réseau revient",
    en: { title: "Your status lights", text: "Here you can read your connection and the link to the database, then the number of contributions already gathered by the whole community. Offline nothing is lost: everything is kept on the device and leaves on its own as soon as the network is back" } },
  { sel: "#app-ver", title: "Ta version", text: "Le numéro de la version que tu utilises. L'application se met à jour d'elle-même : quand une version plus récente existe, une bannière te prévient et un seul bouton l'installe, sans aucune manœuvre technique de ta part",
    en: { title: "Your version", text: "The number of the version you're using. The app updates itself: when a newer version exists, a banner warns you and a single button installs it, with no technical step on your part" } },
  { sel: "#home-link", title: "Revenir à l'accueil", text: "Te ramène à l'écran d'accueil, celui qui présente les trois portes : Traduire, Transcrire et Explorer. Pratique pour changer d'activité d'un seul geste, depuis n'importe quelle page. Le logo et le nom, en haut comme en bas, font la même chose",
    en: { title: "Back to home", text: "Takes you back to the home screen, the one that presents the three doors: Translate, Transcribe and Explore. Handy to switch activity in one move, from any page. The logo and the name, at the top as at the bottom, do the same thing" } },
  { sel: "#lang-chip", title: "Ta langue", text: "Indique la langue dans laquelle tu contribues, et permet d'en changer à tout moment. LANGIAL est communautaire : si ta langue n'existe pas encore, tu peux la déclarer d'ici, et elle deviendra aussitôt disponible pour tous ceux qui la parlent",
    en: { title: "Your language", text: "Shows the language you're contributing in, and lets you change it at any time. LANGIAL is community-driven: if your language doesn't exist yet, you can declare it from here, and it becomes immediately available to everyone who speaks it" } },
  { sel: "#about-link", title: "Découvrir le projet", text: "Ouvre la page qui raconte l'ambition de LANGIAL, pourquoi ta langue mérite d'exister dans le numérique et les trois manières d'y prendre part. C'est la page idéale à montrer à quelqu'un que tu veux convaincre de participer",
    en: { title: "Discover the project", text: "Opens the page that tells LANGIAL's ambition, why your language deserves to exist in the digital world and the three ways to take part. It's the ideal page to show someone you want to convince to join" } },
  { sel: "#btn-notifs", title: "Tes notifications", text: "La cloche te tient au courant de tout ce qui te concerne : une réponse à ta demande, quelqu'un qui cherche un mot dans ta langue, un vote sur ce que tu as proposé. Une pastille compte les nouveautés ; touche une notification pour agir directement dessus, par exemple aller aider la personne d'un seul geste",
    en: { title: "Your notifications", text: "The bell keeps you posted on everything that concerns you: a reply to your request, someone looking for a word in your language, a vote on what you suggested. A badge counts the new ones; tap a notification to act on it directly, for example go and help the person in one move" } },
  { sel: "#help-btn", title: "Cette visite guidée", text: "Le bouton que tu viens d'utiliser. Sur n'importe quelle page il éclaire chaque zone l'une après l'autre et explique à quoi elle sert. Reviens-y sans crainte : rien ne s'enregistre et tu peux passer les étapes quand tu veux",
    en: { title: "This guided tour", text: "The button you've just used. On any page it highlights each area one after another and explains what it's for. Come back to it without fear: nothing is saved and you can skip the steps whenever you want" } },
  { sel: "#bugs-link", title: "Signaler un souci", text: "Un bouton qui coince, une lettre absente du clavier, un envoi qui bloque : décris-le en quelques mots. Tu suis ensuite son traitement jusqu'à la correction, et tu vois la liste des problèmes déjà résolus",
    en: { title: "Report an issue", text: "A button that sticks, a letter missing from the keyboard, a send that stalls: describe it in a few words. You then follow its handling until it's fixed, and you see the list of problems already solved" } },
  { sel: "#theme-toggle", title: "Clair ou sombre", text: "Bascule l'affichage entre fond clair et fond sombre, selon la lumière autour de toi ou simplement ton goût. Ton choix est retenu pour tes prochaines visites, sur cet appareil",
    en: { title: "Light or dark", text: "Switches the display between light and dark background, depending on the light around you or simply your taste. Your choice is remembered for your next visits, on this device" } },
  { sel: "#btn-open-profile", title: "Modifier ton profil", text: "Reviens quand tu veux corriger ton nom, ton village ou tes coordonnées. C'est aussi ici que tu actives ou retires l'affichage de ton nom sur tes contributions rendues publiques",
    en: { title: "Edit your profile", text: "Come back whenever you want to fix your name, your village or your contact details. This is also where you turn on or off showing your name on your public contributions" } },
];
// Navigation entre espaces (visible seulement sur Traduire/Transcrire/Explorer).
const TOUR_NAV = [
  { sel: "#tab-traduire", title: "Aller à Traduire", text: "Bascule vers l'atelier de traduction sans rien perdre de ton travail ailleurs. Pratique pour alterner à ton rythme : quelques traductions, puis quelques voix, puis un passage dans la bibliothèque",
    en: { title: "Go to Translate", text: "Switches to the translation workshop without losing any of your work elsewhere. Handy to alternate at your own pace: a few translations, then a few voices, then a stop in the library" } },
  { sel: "#tab-transcrire", title: "Aller à Transcrire", text: "Passe à l'enregistrement des prononciations. Un même mot peut d'abord être traduit ici, puis prononcé là : les deux gestes se complètent pour documenter la langue en entier",
    en: { title: "Go to Transcribe", text: "Moves to recording pronunciations. A single word can first be translated here, then pronounced there: the two gestures complement each other to document the whole language" } },
  { sel: "#tab-explorer", title: "Aller à Explorer", text: "Ouvre la bibliothèque commune pour voir, écouter et améliorer ce que d'autres ont déjà partagé. Un bon moyen de t'inspirer avant de proposer tes propres réponses",
    en: { title: "Go to Explore", text: "Opens the shared library to see, listen to and improve what others have already shared. A good way to get inspired before offering your own answers" } },
  { sel: "#tab-demander", title: "Aller à Demander", text: "La porte de l'entraide : tu réclames à la communauté la traduction ou la prononciation d'un mot qui te manque, dans la langue de ton choix. Les personnes qui la parlent sont prévenues et peuvent te répondre, et tu es averti dès qu'une réponse arrive",
    en: { title: "Go to Ask", text: "The mutual-help door: you ask the community for the translation or pronunciation of a word you're missing, in the language of your choice. People who speak it are notified and can answer, and you're alerted as soon as a reply comes in" } },
];
// Pied de page (créateur + contact), présent partout.
const TOUR_FOOT = [
  { sel: ".site-footer", title: "Rester en contact", text: "Le projet est porté par Brice Kengni Zanguim. Une question, une idée, une correction sur ta langue : un e-mail ou un message WhatsApp suffit, chaque retour aide à améliorer l'application",
    en: { title: "Stay in touch", text: "The project is led by Brice Kengni Zanguim. A question, an idea, a correction about your language: an email or a WhatsApp message is enough, every piece of feedback helps improve the app" } },
];
// Compose une visite complète : identité, contenu de la vue, navigation, outils, pied.
const withChrome = (content) => [...TOUR_INTRO, ...content, ...TOUR_NAV, ...TOUR_TOOLS, ...TOUR_FOOT];

const TOURS = {
  profile: withChrome([
    { sel: "#c-nom", title: "Qui es-tu", text: "Ton nom et ton prénom servent seulement à te créditer comme contributeur. Tu ne les saisis qu'une fois : ils restent sur cet appareil et te suivent d'une visite à l'autre, sans jamais t'être redemandés",
      en: { title: "Who you are", text: "Your last and first name are only used to credit you as a contributor. You enter them once: they stay on this device and follow you from one visit to the next, never asked again" } },
    { sel: "#village-combo", title: "D'où vient ta parole", text: "Le ngiemboon se dit un peu différemment d'un village à l'autre. Préciser le tien situe ta variante et évite qu'une réponse juste chez toi passe pour une erreur ailleurs. Choisis dans la liste ou tape ton quartier",
      en: { title: "Where your speech comes from", text: "Ngiemboon is said a little differently from one village to another. Stating yours places your variant and prevents an answer that's right where you live from looking like a mistake elsewhere. Pick from the list or type your neighbourhood" } },
    { sel: "#c-role", title: "Comment tu connais la langue", text: "Locuteur natif, apprenant ou linguiste : cette nuance aide à interpréter tes propositions et à leur donner le bon poids. Un natif confirme l'usage courant ; un linguiste apporte la précision de l'écrit",
      en: { title: "How you know the language", text: "Native speaker, learner or linguist: this nuance helps interpret your suggestions and give them the right weight. A native confirms everyday usage; a linguist brings the precision of writing" } },
    { sel: "#c-email", title: "Pour te joindre si besoin", text: "E-mail et téléphone ne servent qu'en cas de doute sur une traduction, à rien d'autre. Ils restent sur ton appareil et ne sont jamais montrés au public. L'indicatif du pays se choisit juste à gauche du numéro",
      en: { title: "To reach you if needed", text: "Email and phone are only used in case of doubt about a translation, nothing else. They stay on your device and are never shown to the public. The country code is chosen just to the left of the number" } },
    { sel: ".field--consent", title: "Ton accord, indispensable", text: "Cette case autorise l'usage de tes contributions pour documenter et outiller la langue. Sans elle impossible de continuer : c'est ce qui rend le partage légitime et respectueux de ton travail",
      en: { title: "Your agreement, essential", text: "This box allows your contributions to be used to document and equip the language. Without it you can't continue: it's what makes sharing legitimate and respectful of your work" } },
    { sel: ".field--credit", title: "Ton nom en public, ou pas", text: "Entièrement facultatif : si tu coches, ton nom apparaît près de tes contributions dans la bibliothèque publique, sous la forme que tu choisis (prénom seul ou sigle). Sinon tu restes tout à fait anonyme",
      en: { title: "Your name in public, or not", text: "Entirely optional: if you tick it, your name appears next to your contributions in the public library, in the form you choose (first name only or initials). Otherwise you stay completely anonymous" } },
    { sel: "#btn-profile-continue", title: "Ouvrir les activités", text: "Une fois remplis les champs marqués d'une étoile, ce bouton déverrouille tout : traduire, transcrire et explorer. Tant qu'une information obligatoire manque, il reste grisé pour te montrer ce qui reste à faire",
      en: { title: "Open the activities", text: "Once the fields marked with a star are filled, this button unlocks everything: translate, transcribe and explore. As long as a required piece of information is missing, it stays greyed out to show you what's left to do" } },
  ]),
  hub: withChrome([
    { sel: ".hub-card[data-go='translate']", title: "Traduire un mot", text: "Tu donnes l'équivalent d'un mot ou d'une phrase, dans un sens ou dans l'autre (français ↔ ngiemboon). Ajouter ta voix par-dessus est un bonus précieux, mais le texte seul suffit déjà pour commencer",
      en: { title: "Translate a word", text: "You give the equivalent of a word or a sentence, one way or the other (French ↔ ngiemboon). Adding your voice on top is a precious bonus, but the text alone is already enough to start" } },
    { sel: ".hub-card[data-go='transcribe']", title: "Prêter ta voix", text: "Ici la prononciation est la vedette : tu enregistres comment un mot se dit vraiment. Le texte peut t'être soufflé, mais c'est ta voix qui capture ce qu'aucune orthographe ne rendra jamais tout à fait",
      en: { title: "Lend your voice", text: "Here pronunciation is the star: you record how a word is really said. The text can be suggested to you, but it's your voice that captures what no spelling will ever fully render" } },
    { sel: ".hub-card[data-go='explore']", title: "Explorer la bibliothèque", text: "Tu parcours ce que la communauté a déjà rassemblé : lire, écouter les prononciations, et proposer une meilleure version quand tu en connais une. Le moyen idéal d'apprendre tout en contribuant",
      en: { title: "Explore the library", text: "You browse what the community has already gathered: read, listen to pronunciations, and offer a better version when you know one. The ideal way to learn while contributing" } },
  ]),
  app: withChrome([
    { sel: ".mode-toggle", title: "Deux façons de travailler", text: "« Se faire proposer un mot » déroule pour toi une file d'items à traiter, sans te demander quoi faire ensuite. « Écrire moi-même » te laisse saisir librement le mot ou la phrase qui te tient à cœur. Tu changes d'avis quand tu veux",
      en: { title: "Two ways to work", text: "“Get a word to work on” rolls out a queue of items to handle for you, without asking what to do next. “Write my own” lets you freely type the word or sentence you care about. You can change your mind anytime" } },
    { sel: "#prop-bar", title: "Ton fil de propositions", text: "En mode automatique les items arrivent groupe par groupe : d'abord les mots, puis les phrases, et le dictionnaire tout à la fin. Le compteur (par exemple « Mots · 7/335 ») marque ta progression ; « Prochain mot » avance sans jamais te resservir ce que tu as déjà traité",
      en: { title: "Your suggestion feed", text: "In automatic mode the items come group by group: first the words, then the sentences, and the dictionary right at the end. The counter (for example “Words · 7/335”) marks your progress; “Next word” moves on without ever serving you again what you've already handled" } },
    { sel: "#req-strip", title: "Les demandes de la communauté", text: "Quand quelqu'un réclame un mot dans ta langue, il apparaît ici, juste au-dessus de ton travail. Touche-le pour le traiter tout de suite : ta réponse lui parviendra automatiquement, sans que tu aies à le recontacter. C'est le pont entre celui qui cherche et toi qui sais",
      en: { title: "The community's requests", text: "When someone asks for a word in your language, it appears here, right above your work. Tap it to handle it at once: your answer reaches them automatically, without you having to contact them back. It's the bridge between whoever is looking and you who know" } },
    { sel: "#dir-toggle", title: "Le sens de traduction", text: "Choisis si tu pars du français vers le ngiemboon ou l'inverse. Les étiquettes FR et NGE des champs suivent ton choix, pour que tu saches toujours quelle langue va où. Bien utile selon la langue dans laquelle tu penses le mieux",
      en: { title: "The translation direction", text: "Choose whether you go from French to ngiemboon or the other way. The FR and NGE labels of the fields follow your choice, so you always know which language goes where. Quite useful depending on the language you think best in" } },
    { sel: "#source", title: "L'item de départ", text: "Le mot ou la phrase à traiter s'affiche ici. En mode proposé il est déjà rempli pour toi ; en mode libre c'est toi qui l'écris. C'est le point d'appui auquel ta réponse va répondre",
      en: { title: "The starting item", text: "The word or sentence to handle appears here. In suggested mode it's already filled in for you; in free mode you write it yourself. It's the anchor your answer will respond to" } },
    { sel: "#target-wrap", title: "Ta réponse en ngiemboon", text: "Touche ce champ : le clavier ngiemboon s'ouvre, avec les lettres et les tons propres à la langue, absents des claviers ordinaires. Tu écris ta traduction avec les bons caractères plutôt qu'une approximation",
      en: { title: "Your answer in ngiemboon", text: "Tap this field: the ngiemboon keyboard opens, with the letters and tones specific to the language, absent from ordinary keyboards. You write your translation with the right characters rather than an approximation" } },
    { sel: "#tips-toggle", title: "L'aide à la prononciation", text: "Quand elle est active, chaque touche pressée montre comment la lettre se prononce, avec un exemple simple en français. Idéale si tu découvres l'alphabet ; tu pourras la couper une fois à l'aise",
      en: { title: "The pronunciation help", text: "When it's on, each key you press shows how the letter is pronounced, with a simple example. Ideal if you're discovering the alphabet; you can turn it off once you're comfortable" } },
    { sel: "#domaine", title: "Situer le mot (facultatif)", text: "Le domaine (parenté, nourriture, nature…) et la note (registre, contexte d'emploi) ne sont pas obligatoires, mais ils rendent ta contribution bien plus utile : deux mots proches se distinguent souvent par leur seul contexte",
      en: { title: "Place the word (optional)", text: "The domain (kinship, food, nature…) and the note (register, context of use) are not required, but they make your contribution far more useful: two close words are often told apart by their context alone" } },
    { sel: ".audio-row", title: "Enregistrer la voix", text: "Un appui lance l'enregistrement, un autre l'arrête ; tu peux réécouter puis recommencer autant que tu veux. En Traduire c'est un plus, en Transcrire c'est le cœur même de la contribution. « Tester le micro » vérifie d'abord que tout marche",
      en: { title: "Record the voice", text: "One tap starts the recording, another stops it; you can listen back then start over as many times as you like. In Translate it's a plus, in Transcribe it's the very heart of the contribution. “Test the microphone” first checks that everything works" } },
    { sel: "#btn-trim-audio", title: "Ne garder que le bon passage", text: "Si une partie seulement de ton enregistrement est réussie (une porte qui s'ouvre, une radio qui s'allume ont fait du bruit ailleurs), ce bouton ouvre un outil pour délimiter la portion à conserver, en glissant deux poignées sur l'onde ou en saisissant le début et la fin en secondes. Tu écoutes la sélection, puis tu la gardes : tout le reste est supprimé, sans avoir à tout réenregistrer",
      en: { title: "Keep only the good part", text: "If only a part of your recording is good (a door opening, a radio switching on made noise elsewhere), this button opens a tool to delimit the portion to keep, by dragging two handles on the wave or typing the start and end in seconds. You listen to the selection, then keep it: all the rest is removed, without having to record everything again" } },
    { sel: "#add-translation", title: "Ajouter une traduction", text: "En Transcrire, seule ta voix est demandée : c'est l'essentiel. Ce bouton, tout en bas, déplie en plus un champ pour écrire la traduction du mot si tu la connais. C'est un bonus, jamais une obligation : tu peux l'ignorer sans souci",
      en: { title: "Add a translation", text: "In Transcribe, only your voice is asked: that's the essential part. This button, right at the bottom, additionally unfolds a field to write the word's translation if you know it. It's a bonus, never a requirement: you can ignore it with no worry" } },
    { sel: "#add-transcription", title: "Ajouter ta voix", text: "En Traduire, l'écrit suffit. Ce bouton, tout en bas, déplie en plus l'outil d'enregistrement pour prononcer le mot si le cœur t'en dit. Une traduction accompagnée de sa voix est bien plus précieuse, mais reste entièrement facultative",
      en: { title: "Add your voice", text: "In Translate, text is enough. This button, right at the bottom, additionally unfolds the recording tool to pronounce the word if you feel like it. A translation with its voice is far more valuable, but stays entirely optional" } },
    { sel: "#btn-save", title: "Garder ta contribution", text: "Ta réponse est d'abord rangée en sécurité sur ton appareil, même sans réseau. Rien ne part encore : tu peux enchaîner tranquillement plusieurs items, puis tout transmettre d'un coup un peu plus tard",
      en: { title: "Keep your contribution", text: "Your answer is first stored safely on your device, even without network. Nothing leaves yet: you can calmly go through several items, then send them all at once a little later" } },
    { sel: ".send-row", title: "Transmettre à la base", text: "L'envoi regroupe tout ce qui attend. Il est conçu pour ne rien perdre : chaque contribution est renvoyée jusqu'à ce que la base confirme l'avoir bien reçue, même quand le réseau est capricieux",
      en: { title: "Send to the database", text: "Sending gathers everything that's waiting. It's designed to lose nothing: each contribution is resent until the database confirms it received it, even when the network is capricious" } },
    { sel: "#send-search-wrap", title: "Retrouver une contribution", text: "Quand ta liste s'allonge, ce champ la filtre à mesure que tu tapes : quelques lettres suffisent pour retrouver un mot ou une phrase parmi tout ce que tu as déjà envoyé, sans faire défiler",
      en: { title: "Find a contribution", text: "When your list grows long, this field filters it as you type: a few letters are enough to find a word or a sentence among everything you've already sent, without scrolling" } },
    { sel: "#grp-pending", title: "Ce qui reste à confirmer", text: "La liste de ce que la base n'a pas encore confirmé. L'application y revient d'elle-même, en boucle, jusqu'à ce que tout soit parti ; « Renvoyer maintenant » force une nouvelle tentative si tu es pressé",
      en: { title: "What's left to confirm", text: "The list of what the database hasn't confirmed yet. The app comes back to it on its own, in a loop, until everything is gone; “Resend now” forces a new attempt if you're in a hurry" } },
    { sel: "#grp-sent", title: "Ce qui est bien arrivé", text: "Tout ce que la base a confirmé avoir reçu, coché et à l'abri. Quand une contribution passe ici, tu as la certitude qu'elle est enregistrée pour de bon, pas seulement lancée dans le vide",
      en: { title: "What arrived safely", text: "Everything the database confirmed receiving, checked and safe. When a contribution moves here, you're certain it's saved for good, not just thrown into the void" } },
  ]),
  explore: withChrome([
    { sel: "#explore-search", title: "Chercher un mot", text: "Tape quelques lettres pour retrouver aussitôt un mot ou une phrase parmi tout ce qui a été partagé. Bien pratique pour vérifier si une réponse existe déjà avant d'en proposer une nouvelle",
      en: { title: "Search a word", text: "Type a few letters to instantly find a word or a sentence among everything that's been shared. Quite handy to check whether an answer already exists before offering a new one" } },
    { sel: ".explore-filters", title: "Affiner la liste", text: "Filtre par sens de traduction, rôle du contributeur, variante de village ou domaine. En combinant ces filtres tu isoles par exemple les seules réponses des locuteurs natifs de ton propre village",
      en: { title: "Narrow the list", text: "Filter by translation direction, contributor role, village variant or domain. By combining these filters you isolate, for example, only the answers of native speakers from your own village" } },
    { sel: "#explore-list .grp-card", title: "Un mot, toutes ses réponses", text: "Chaque cadre réunit toutes les propositions d'un même mot avec ses compteurs : nombre de réponses, de villages représentés, d'enregistrements. Touche-le pour ouvrir le détail et écouter les voix",
      en: { title: "One word, all its answers", text: "Each frame gathers all the suggestions for a single word with its counters: number of answers, of villages represented, of recordings. Tap it to open the detail and listen to the voices" } },
    { sel: "#explore-list .grp-card .grp-consensus", title: "La réponse qui fait consensus", text: "Lorsqu'une même réponse revient assez souvent dans ton village, elle ressort ici comme la variante de référence pour toi. Ce sont les usages de ta communauté qui priment, pas ceux d'un autre village",
      en: { title: "The consensus answer", text: "When the same answer comes back often enough in your village, it stands out here as the reference variant for you. It's your community's usage that prevails, not that of another village" } },
  ]),
  about: withChrome([
    { sel: ".about-head", title: "La page qui raconte le projet", text: "Un espace à part pour présenter LANGIAL : d'où vient son nom, quelle ambition le porte et comment n'importe qui peut y prendre part. C'est la page à partager pour donner à d'autres l'envie de contribuer",
      en: { title: "The page that tells the project", text: "A dedicated space to present LANGIAL: where its name comes from, what ambition drives it and how anyone can take part. It's the page to share to give others the urge to contribute" } },
    { sel: ".about-vision", title: "L'ambition de fond", text: "Bien plus qu'un simple dictionnaire : rassembler mots et voix pour donner à nos langues des claviers, des traducteurs et des IA qui les comprennent. Le ngiemboon montre la voie, l'horizon vise toutes nos langues",
      en: { title: "The underlying ambition", text: "Far more than a mere dictionary: gathering words and voices to give our languages keyboards, translators and AIs that understand them. Ngiemboon leads the way, the horizon aims at all our languages" } },
    { sel: "#about-grid-why", title: "Ce que ça change vraiment", text: "Trois enjeux réunis : préserver ce qui pourrait se perdre, outiller la langue pour qu'elle vive dans les téléphones et les ordinateurs, et le faire ensemble, car une langue appartient à ceux qui la parlent",
      en: { title: "What it really changes", text: "Three stakes brought together: preserving what could be lost, equipping the language so it lives in phones and computers, and doing it together, because a language belongs to those who speak it" } },
    { sel: "#about-grid-how", title: "Par où mettre la main", text: "Trois portes d'entrée complémentaires : traduire pour le sens, transcrire pour le son, explorer pour affiner. Tu n'es tenu à aucune : même un seul mot par jour fait grossir le trésor commun",
      en: { title: "Where to lend a hand", text: "Three complementary entry doors: translate for meaning, transcribe for sound, explore to refine. You're bound to none: even a single word a day grows the shared treasure" } },
    { sel: ".about-share", title: "Faire passer le mot", text: "Le projet grandit avec le nombre de contributeurs. Montre le QR code autour de toi ou récupère le flyer en image ou en PDF pour le diffuser : plus on est nombreux, plus la langue est richement documentée",
      en: { title: "Spread the word", text: "The project grows with the number of contributors. Show the QR code around you or grab the flyer as an image or PDF to spread it: the more we are, the more richly the language is documented" } },
    { sel: ".about-cta", title: "Se lancer", text: "« Commencer à contribuer » t'emmène droit aux activités de collecte, « Retour » te ramène à l'écran d'où tu venais. Rien ne presse : tu peux explorer d'abord et contribuer quand tu te sens prêt",
      en: { title: "Get started", text: "“Start contributing” takes you straight to the collection activities, “Back” returns you to the screen you came from. No rush: you can explore first and contribute when you feel ready" } },
  ]),
  lang: withChrome([
    { sel: "#lang-search", title: "Chercher une langue", text: "Tape le nom d'une langue, une région ou un pays : la liste se filtre à mesure que tu écris. Bien pratique quand beaucoup de langues sont déjà déclarées, pour retrouver la tienne d'un coup d'œil",
      en: { title: "Search a language", text: "Type the name of a language, a region or a country: the list filters as you write. Quite handy when many languages are already declared, to find yours at a glance" } },
    { sel: "#lang-declare-btn", title: "Déclarer ta langue", text: "Si ta langue n'apparaît pas encore dans la liste, ce bouton ouvre un court formulaire pour la créer. Elle devient aussitôt disponible pour toi et pour toute personne qui la parle : LANGIAL est fait pour accueillir toutes nos langues",
      en: { title: "Declare your language", text: "If your language doesn't appear in the list yet, this button opens a short form to create it. It becomes immediately available to you and to anyone who speaks it: LANGIAL is made to welcome all our languages" } },
    { sel: "#lang-grid", title: "Choisir ta langue", text: "Chaque carte est une langue déjà présente : touche-la pour contribuer dans cette langue. Le ngiemboon a son clavier dédié avec les tons ; les autres s'écrivent avec le clavier habituel de ton téléphone en attendant le leur",
      en: { title: "Choose your language", text: "Each card is a language already present: tap it to contribute in that language. Ngiemboon has its dedicated keyboard with the tones; the others are written with your phone's usual keyboard while waiting for their own" } },
    { sel: "#lang-merge-panel", title: "Réunir les doublons", text: "Deux personnes ont parfois créé la même langue sous des écritures différentes. LANGIAL te le signale ici : tu peux confirmer une fusion qu'on te propose, accepter une ressemblance repérée automatiquement, ou choisir toi-même deux langues que tu sais identiques et proposer de les réunir. La fusion n'a lieu qu'avec l'accord des personnes concernées, et rien n'est perdu : les orthographes et les régions des deux sont conservées",
      en: { title: "Merge duplicates", text: "Two people sometimes created the same language under different spellings. LANGIAL flags it for you here: you can confirm a merge proposed to you, accept a resemblance spotted automatically, or pick two languages yourself that you know are identical and propose to merge them. The merge only happens with the agreement of the people concerned, and nothing is lost: the spellings and regions of both are kept" } },
    { sel: "#ld-nom", title: "Le nom de la langue", text: "Écris le nom sous lequel ta langue est connue. Pendant que tu tapes, LANGIAL compare avec les langues déjà déclarées pour t'éviter de créer un doublon sous une orthographe un peu différente",
      en: { title: "The language name", text: "Write the name your language is known by. As you type, LANGIAL compares with the languages already declared to save you from creating a duplicate under a slightly different spelling" } },
    { sel: "#ld-pays", title: "Le pays", text: "Le pays où la langue est parlée. On part du plus large, le pays, avant de préciser la région : cela situe d'emblée la langue sur la carte",
      en: { title: "The country", text: "The country where the language is spoken. We start from the broadest, the country, before narrowing to the region: it places the language on the map right away" } },
    { sel: "#ld-region", title: "Où on la parle", text: "La région ou la localité, plus précise que le pays. Deux langues de noms proches mais de régions éloignées sont sans doute distinctes, et cette précision aide à ne pas les confondre",
      en: { title: "Where it's spoken", text: "The region or locality, more precise than the country. Two languages with close names but distant regions are probably distinct, and this precision helps not to confuse them" } },
    { sel: "#ld-similar", title: "Éviter les doublons", text: "Si une langue déjà présente ressemble à la tienne (même écrite autrement), elle s'affiche ici. Si c'est bien la même, choisis-la plutôt que d'en créer une seconde : on garde ainsi une seule entrée par langue, plus riche",
      en: { title: "Avoid duplicates", text: "If a language already present resembles yours (even spelled differently), it shows up here. If it's really the same, pick it rather than create a second one: we thus keep a single, richer entry per language" } },
    { sel: "#ld-submit", title: "Créer la langue", text: "Valide la déclaration une fois le nom et la région renseignés. Ta langue rejoint aussitôt la liste et devient la tienne pour contribuer ; tu pourras toujours l'affiner plus tard",
      en: { title: "Create the language", text: "Confirm the declaration once the name and region are filled in. Your language joins the list right away and becomes yours to contribute in; you can always refine it later" } },
  ]),
  bugs: withChrome([
    { sel: ".bug-report", title: "Décrire le problème", text: "Donne un titre clair puis raconte ce qui s'est passé : sur quel écran, à quel moment, comment le refaire apparaître. Précise la gravité et la zone concernée : plus c'est détaillé, plus la correction arrive vite",
      en: { title: "Describe the problem", text: "Give a clear title then tell what happened: on which screen, at what moment, how to make it appear again. State the severity and the area concerned: the more detailed, the faster the fix arrives" } },
    { sel: "#bugs-grp-open", title: "Les soucis en attente", text: "Tout ce qui n'est pas encore réglé, classé du plus gênant au plus léger. Ton signalement vient s'y ranger et tu peux suivre son avancement, du repérage jusqu'à la résolution",
      en: { title: "Pending issues", text: "Everything not yet settled, sorted from the most annoying to the lightest. Your report lands here and you can follow its progress, from spotting to resolution" } },
    { sel: "#bugs-grp-done", title: "Les soucis déjà réglés", text: "L'historique des problèmes corrigés, avec la date et la nature du correctif. Un bon endroit pour vérifier qu'un souci que tu rencontres n'a pas déjà été traité dans une version plus récente",
      en: { title: "Issues already fixed", text: "The history of fixed problems, with the date and the nature of the fix. A good place to check that an issue you're hitting hasn't already been handled in a newer version" } },
  ]),
  demander: withChrome([
    { sel: "#req-texte", title: "Le mot qui te manque", text: "Écris le mot ou la phrase dont tu cherches la traduction ou la prononciation. C'est le point de départ de ta demande : sois précis, quitte à ajouter le contexte plus bas si le mot a plusieurs sens",
      en: { title: "The word you're missing", text: "Write the word or sentence whose translation or pronunciation you're looking for. It's the starting point of your request: be precise, and add the context below if the word has several meanings" } },
    { sel: "#req-langue", title: "Dans quelle langue", text: "Choisis la langue dans laquelle tu veux la réponse. Les personnes qui parlent cette langue sont alors prévenues qu'on a besoin d'elles. Si ta langue n'est pas dans la liste, un champ s'ouvre pour la déclarer sur-le-champ",
      en: { title: "In which language", text: "Choose the language you want the answer in. People who speak that language are then notified they're needed. If your language isn't in the list, a field opens to declare it right away" } },
    { sel: "#req-kind", title: "Ce que tu réclames", text: "Précise si tu veux la traduction écrite, la prononciation à voix haute, ou les deux à la fois. Celui qui te répondra saura ainsi exactement quoi te fournir, sans avoir à deviner",
      en: { title: "What you're asking for", text: "State whether you want the written translation, the spoken pronunciation, or both at once. Whoever answers will then know exactly what to provide, without guessing" } },
    { sel: "#req-note", title: "Le contexte (facultatif)", text: "Une précision libre : où tu as entendu le mot, ce que tu crois qu'il veut dire, dans quelle situation il sert. Ce détail aide énormément à te donner la bonne réponse plutôt qu'un homonyme",
      en: { title: "The context (optional)", text: "A free precision: where you heard the word, what you think it means, in what situation it's used. This detail helps enormously to give you the right answer rather than a homonym" } },
    { sel: "#req-send", title: "Publier ta demande", text: "Une fois les champs marqués d'une étoile remplis, ce bouton lance ta demande vers la communauté. Les personnes qui parlent la langue sont averties, et tu reçois une notification dès que l'une d'elles te répond",
      en: { title: "Publish your request", text: "Once the fields marked with a star are filled, this button sends your request out to the community. People who speak the language are alerted, and you get a notification as soon as one of them answers you" } },
    { sel: "#req-list", title: "Les demandes en attente", text: "Toutes les demandes encore sans réponse, la tienne comme celles des autres. Si tu parles l'une de ces langues, tu peux répondre ici même et rendre à ton tour le service que tu attends. Le filtre par langue t'aide à ne voir que celles que tu peux traiter",
      en: { title: "The pending requests", text: "All the requests still without an answer, yours and others'. If you speak one of these languages, you can answer right here and offer in turn the service you're waiting for. The language filter helps you see only the ones you can handle" } },
  ]),
  notifs: withChrome([
    { sel: "#notif-markall", title: "Tout marquer comme lu", text: "D'un seul geste, ce bouton fait passer toutes tes notifications en « lues » et remet la pastille à zéro. Pratique pour repartir sur une base propre quand tu as pris connaissance de tout",
      en: { title: "Mark all as read", text: "In one move, this button turns all your notifications to “read” and resets the badge to zero. Handy to start fresh once you've taken note of everything" } },
    { sel: "#notif-feed", title: "Ton fil d'événements", text: "Chaque ligne raconte quelque chose qui te concerne, la plus récente en haut, avec sa date. Les non lues ressortent. Beaucoup sont cliquables : une demande t'emmène là où tu peux y répondre, un vote te ramène à la contribution concernée. Rien ne se perd, tout est daté",
      en: { title: "Your event feed", text: "Each line tells something that concerns you, the most recent on top, with its date. Unread ones stand out. Many are clickable: a request takes you where you can answer it, a vote brings you back to the contribution concerned. Nothing is lost, everything is dated" } },
  ]),
};
let _tourSteps = [], _tourIdx = 0;
function tourEl() { return _tourSteps[_tourIdx] ? document.querySelector(_tourSteps[_tourIdx].sel) : null; }
function tourReposition() {
  const el = tourEl(); if (!el) { endTour(); return; }
  const r = el.getBoundingClientRect(), pad = 8, gap = 12, m = 12;
  const spot = $("#tour-spot"), card = $("#tour-card");
  spot.style.top = (r.top - pad) + "px"; spot.style.left = (r.left - pad) + "px";
  spot.style.width = (r.width + pad * 2) + "px"; spot.style.height = (r.height + pad * 2) + "px";
  // On MESURE la carte réelle (contenu dense de longueur variable) pour la placer
  // entièrement dans l'écran, jamais coupée : dessous si ça tient, sinon dessus,
  // sinon calée dans le cadre. Horizontalement, alignée au repère puis bornée.
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let top;
  if (r.bottom + gap + ch + m <= vh) top = r.bottom + gap;          // dessous
  else if (r.top - gap - ch - m >= 0) top = r.top - gap - ch;       // dessus
  else top = Math.max(m, Math.min(vh - ch - m, r.bottom + gap));    // calée dans l'écran
  card.style.top = Math.max(m, Math.min(top, vh - ch - m)) + "px";
  card.style.left = Math.max(m, Math.min(r.left, vw - cw - m)) + "px";
}
function tourGoto() {
  const el = tourEl(); if (!el) { endTour(); return; }
  const s = _tourSteps[_tourIdx];
  const loc = (getUiLang() === "en" && s.en) ? s.en : s;   // libellé dans la langue d'interface
  $("#tour-step").textContent = t("tour.step").replace("{i}", _tourIdx + 1).replace("{n}", _tourSteps.length);
  $("#tour-title").textContent = loc.title;
  $("#tour-text").textContent = loc.text;
  $("#tour-card").dataset.sel = s.sel;   // repère de la zone visée (débogage + vérification)
  $("#tour-next").textContent = _tourIdx === _tourSteps.length - 1 ? t("tour.done") : t("tour.next");
  tourReposition();
  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
}
// Ne retient que les étapes dont l'élément est RÉELLEMENT visible (présent + de
// taille non nulle) : écarte proprement les zones masquées (vue cachée, bouton
// « Mon profil » caché sur l'accueil, groupes d'envoi encore vides…).
function tourVisible(sel) {
  const el = document.querySelector(sel); if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
function startTour(steps) {
  _tourSteps = (steps || []).filter((s) => tourVisible(s.sel));
  if (!_tourSteps.length) { toast(t("toast.guide.none"), "warn"); return; }
  _tourIdx = 0;
  $("#tour").hidden = false;
  tourGoto();
  window.addEventListener("scroll", tourReposition, { passive: true });
  window.addEventListener("resize", tourReposition);
}
function endTour() {
  $("#tour").hidden = true;
  window.removeEventListener("scroll", tourReposition);
  window.removeEventListener("resize", tourReposition);
}
function initTour() {
  const help = $("#help-btn");
  if (help) help.addEventListener("click", () => startTour(TOURS[_currentView]));
  const next = $("#tour-next");
  if (next) next.addEventListener("click", () => { _tourIdx++; if (_tourIdx >= _tourSteps.length) endTour(); else tourGoto(); });
  const skip = $("#tour-skip");
  if (skip) skip.addEventListener("click", endTour);
}

// --- Explorer : bibliothèque communautaire (lecture assainie) --------------
// Deux niveaux : (1) une GRILLE de « cadres » — un par mot/expression (headword),
// avec des métriques agrégées ; (2) au clic, le DÉTAIL du mot : les propositions
// individuelles regroupées PAR VILLAGE, chacune améliorable/votable. Le consensus
// est calculé PAR VILLAGE (les variantes villageoises sont toutes potentiellement
// justes), et un avertissement prévient quand une proposition vient d'un autre
// village que celui du lecteur.
let _exploreEntries = [];      // entrées ACTUELLEMENT affichées (scopées sur la langue choisie)
let _exploreAll = [];          // TOUTES les entrées chargées (toutes langues), pour changer de scope sans recharger
let _exploreLangFilter = null; // langue affichée : null = non initialisé, "" = toutes, sinon id canonique
let _exploreGroups = [];
let _openGroupKey = null;
let _exploreInit = false;
const ROLE_LBL = { natif: "Locuteur natif", apprenant: "Apprenant", linguiste: "Linguiste" };
// Libellé de rôle dans la langue d'interface (réutilise les clés du profil).
function roleLabel(role) {
  const k = "p.role." + role;
  const s = t(k);
  return s !== k ? s : (ROLE_LBL[role] || role);
}
function initExploreOnce() {
  if (_exploreInit) return; _exploreInit = true;
  ["#filter-direction", "#filter-role", "#filter-variante", "#filter-domaine"].forEach((s) => {
    const el = $(s); if (el) el.addEventListener("change", renderExplore);
  });
  // Changer la LANGUE affichée re-scope tout Explorer (liste + carte + autres filtres)
  // sans nouveau chargement réseau : on filtre localement les entrées déjà en mémoire.
  const langSel = $("#filter-lang");
  if (langSel) langSel.addEventListener("change", () => {
    _exploreLangFilter = langSel.value;
    applyExploreLangScope();
    populateExploreFilters();
    renderExplore();
  });
  // Cliquer un village de la carte filtre la liste sur ce village (re-cliquer = tout).
  const vmap = $("#variant-map");
  if (vmap) {
    const pick = (node) => {
      const v = node.getAttribute("data-village"); if (!v) return;
      const fv = $("#filter-variante"); if (!fv) return;
      fv.value = (fv.value === v) ? "" : v;         // bascule : re-cliquer le même = retire le filtre
      refreshEnhancedSelects();
      renderExplore();
    };
    vmap.addEventListener("click", (e) => {
      const node = e.target.closest && e.target.closest(".vmap-node"); if (node) pick(node);
    });
    vmap.addEventListener("keydown", (e) => {
      const node = e.target.closest && e.target.closest(".vmap-node");
      if (node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(node); }
    });
  }
  const search = $("#explore-search");
  if (search) search.addEventListener("input", renderExplore);
  const list = $("#explore-list");
  if (list) {
    list.addEventListener("click", onExploreClick);
    list.addEventListener("change", onExploreChange);
    list.addEventListener("keydown", (e) => {
      const card = e.target.closest && e.target.closest(".grp-card");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openGroup(card.dataset.key); }
    });
  }
}
/** Langue d'une entrée = champ `langue` si présent, sinon le côté non-« fr » des
    lang (héritage : contributions antérieures au multi-langue → langue graine). */
function entryLang(e) {
  if (e.langue) return e.langue;
  if (e.source_lang && e.source_lang !== "fr") return e.source_lang;
  if (e.target_lang && e.target_lang !== "fr") return e.target_lang;
  return "nge";
}
/** Résout un id de langue vers sa CANONIQUE (Phase C) : une langue fusionnée dans une
    autre redirige vers celle-ci, à la sélection comme dans le corpus (rien n'est perdu). */
function canonLangId(id) {
  try { return resolveCanonicalId(id, knownLanguages()) || id; } catch (e) { return id; }
}
// ── ENCODAGE DES LANGUES (règle unique) ─────────────────────────────────────
// Toute langue est identifiée par son CODE ≤3 lettres (nge, bas, dua, …) ; le nom
// affiché (« Ngiemboon ») en dérive via _langNameById. La DIRECTION d'une entrée
// s'encode donc « fr2<code> » / « <code>2fr » avec le VRAI code, jamais un « nge »
// figé pour toutes les langues (ce littéral historique fusionnait à tort deux
// langues partageant le même mot source dans Explorer).
/** Orientation d'une direction, indépendante de la langue : "fr2l" (FR→langue) ou "l2fr". */
function dirOrient(d) { return String(d || "").endsWith("2fr") ? "l2fr" : "fr2l"; }
/** Direction CANONIQUE d'une entrée : fr2<code>/<code>2fr avec le vrai code de langue.
 *  Rétro-compatible : reconstruit le code depuis langue/source_lang/target_lang si l'ancien
 *  « fr2nge » a été stocké pour une autre langue. */
function dirCanon(e) {
  const code = canonLangId(entryLang(e));
  return dirOrient(e && e.direction) === "l2fr" ? code + "2fr" : "fr2" + code;
}
/** Nettoie un texte pour le partage (une ligne, borné). */
function shareClean(s, max) { return (s || "").toString().replace(/\s+/g, " ").trim().slice(0, max || 120); }
/** Lien DIRECT vers une entrée d'Explorer (rouvre le mot visé). */
function entryDeepLink(src, dir) {
  const base = location.origin + location.pathname;
  const w = encodeURIComponent(shareClean(src, 80));
  return base + "#/explorer?w=" + w + (dir ? "&d=" + encodeURIComponent(dir) : "");
}
/** Partage ADAPTATIF d'une entrée : texte marketing (mot, langues, question, CTA) + lien direct,
    via le panneau réseaux custom (tous supports). Le contenu s'adapte au sens et à ce qui existe. */
async function shareEntry(src, tgt, dir, hasAudio) {
  const L = currentLang();
  const s = shareClean(src), tg = shareClean(tgt);
  const url = entryDeepLink(src, dir);
  // Cas de partage : une traduction précise (avec cible) ou une prononciation (audio, sans cible).
  const caseKey = (!tg && hasAudio) ? "entry-transc" : "entry-trad";
  const ctx = { w: s, lang: L.nom, tr: tg };
  openSharePanel(url, caseKey, ctx);   // panneau réseaux (texte marketing propre à chaque plateforme), tous supports
}

/** Télécharge le dictionnaire de la LANGUE COURANTE (entrées visibles) en CSV ou JSON. */
async function downloadDict(fmt) {
  const { entriesToCSV, entriesToJSON, entriesToLIFT, entriesToCLDF, entriesToELAN, exportFilename } = await import("./export.js");
  const lid = getCurrentLangId();
  const entries = _exploreEntries || [];
  let content, mime;
  if (fmt === "json") {
    content = entriesToJSON(entries, { langue: lid, nom: currentLang().nom, exporte_par: "LANGIAL" });
    mime = "application/json";
  } else if (fmt === "lift") {
    content = entriesToLIFT(entries, { langId: lid });
    mime = "application/xml";
  } else if (fmt === "elan") {
    content = entriesToELAN(entries, { langId: lid });
    mime = "application/xml";
  } else if (fmt === "cldf") {
    content = entriesToCLDF(entries, { langId: lid });
    mime = "text/csv";
  } else {
    content = entriesToCSV(entries);
    mime = "text/csv";
  }
  try {
    const blob = new Blob([content], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(lid, fmt);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ok */ } }, 1500);
    toast(`Dictionnaire exporté · ${entries.length} ${entries.length === 1 ? "entrée" : "entrées"}`, "ok");
  } catch (e) {
    toast(t("toast.export.na"), "err");
  }
}

// Cache LOCAL de la bibliothèque (Explorer) : permet un affichage INSTANTANÉ du dernier contenu
// connu à l'ouverture, sans écran de chargement vide, puis revalidation réseau en arrière-plan
// (stale-while-revalidate au niveau des données). Garde-fou de taille (quota localStorage ~5 Mo).
const _EXPLORE_CACHE_KEY = "langa-explore-cache";
function _loadExploreCache() {
  try { const o = JSON.parse(localStorage.getItem(_EXPLORE_CACHE_KEY) || "null"); return (o && Array.isArray(o.entries)) ? o.entries : null; } catch (e) { return null; }
}
function _saveExploreCache(entries) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), entries: (entries || []).slice(0, 1500) });
    if (payload.length < 2000000) localStorage.setItem(_EXPLORE_CACHE_KEY, payload);   // ~2 Mo max, sinon on n'encombre pas
    else localStorage.removeItem(_EXPLORE_CACHE_KEY);
  } catch (e) { /* quota plein : on ignore, la revalidation réseau reste la source de vérité */ }
}
/** Applique un jeu d'entrées à l'Explorer (filtre le contenu dégénéré, scope de langue,
    apprentissage prédictif, filtres, rendu). Partagé par le rendu depuis le cache ET le réseau. */
function _applyLibraryData(entries) {
  // On ignore les entrées SANS AUCUN contenu (ni mot source, ni traduction, ni audio jouable ;
  // de telles entrées dégénérées créaient un groupe « — » vide, cf. BUG-U-mrmae78s-7670).
  _exploreAll = (entries || []).filter((e) => (e.source_text && e.source_text.trim()) ||
    (e.target_text && e.target_text.trim()) || isPlayable(e.audio_url));
  // Par DÉFAUT, Explorer se scope sur la langue de l'utilisateur ; sinon « Toutes les langues ».
  if (_exploreLangFilter === null)
    _exploreLangFilter = hasChosenLang() ? canonLangId(getCurrentLangId()) : "";
  // Le clavier prédictif APPREND des contributions réelles de la langue de l'utilisateur.
  const lid = hasChosenLang() ? canonLangId(getCurrentLangId()) : null;
  if (predict && lid && usesDedicatedKeyboard(lid))
    predict.learnFromEntries(_exploreAll.filter((e) => canonLangId(entryLang(e)) === lid), lid);
  applyExploreLangScope();
  populateExploreFilters();
  renderExplore();
}
async function loadLibrary() {
  initExploreOnce();
  const status = $("#explore-status"), list = $("#explore-list");
  // 1) RENDU INSTANTANÉ depuis le cache local, s'il existe (aucun écran de chargement vide).
  const cached = _loadExploreCache();
  const fromCache = !!(cached && cached.length);
  if (fromCache) _applyLibraryData(cached);
  else { if (status) status.textContent = t("exp.loading"); if (list) list.innerHTML = ""; }
  // 2) REVALIDATION réseau en arrière-plan → met à jour l'affichage ET le cache.
  try {
    const data = await browseLibrary({ limit: 500, device_id: deviceId() });
    _applyLibraryData((data && data.entries) || []);
    _saveExploreCache(_exploreAll);
  } catch (e) {
    if (!fromCache) {   // rien à montrer ET le réseau échoue → message hors-ligne
      _exploreAll = []; _exploreEntries = [];
      if (status) status.textContent = "";
      if (list) list.innerHTML = `<div class="explore-empty"><img class="empty-illus" src="icons/state-offline.webp" alt="" aria-hidden="true"><div class="empty-msg">${t("exp.loadfail")}</div></div>`;
    }
    // si on avait déjà le cache affiché, on le garde tel quel (pas d'erreur intrusive hors-ligne)
  }
  applyExploreDeepLink();   // lien direct #/explorer?w=…&d=… → ouvre l'entrée visée
}
/** Applique le scope de langue courant : `_exploreEntries` = sous-ensemble de
    `_exploreAll` filtré sur la langue choisie (« » = toutes les langues). */
function applyExploreLangScope() {
  const lf = _exploreLangFilter;
  _exploreEntries = lf
    ? _exploreAll.filter((e) => canonLangId(entryLang(e)) === lf)
    : _exploreAll.slice();
}
// Deep-link : si l'URL cible un mot précis, pré-remplit la recherche et OUVRE le groupe.
let _deepWord = null, _deepDir = null;
function applyExploreDeepLink() {
  if (!_deepWord) return;
  const w = _deepWord, d = _deepDir; _deepWord = _deepDir = null;
  const sb = $("#explore-search"); if (sb) sb.value = w;
  renderExplore();
  // Match tolérant au littéral hérité : même mot source ET même orientation (fr→langue / langue→fr).
  let g = _exploreGroups.find((x) => _normKey(x.source_text) === _normKey(w) && dirOrient(x.direction) === dirOrient(d))
       || _exploreGroups.find((x) => _normKey(x.source_text) === _normKey(w));
  if (g) openGroup(g.key);
}
function populateExploreFilters() {
  const uniq = (key) => [...new Set(_exploreEntries.map((e) => e[key]).filter(Boolean))].sort();
  const fill = (id, allLabel, values) => {
    const sel = $(id); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    sel.value = values.includes(cur) ? cur : "";
  };
  fill("#filter-variante", t("exp.f.variante"), uniq("variante"));
  fill("#filter-domaine", t("exp.f.domaine"), uniq("domaine"));
  // Sélecteur de LANGUE affichée : « Toutes les langues » + une entrée par langue
  // présente (id canonique, nom + nombre de contributions), triée par volume.
  const lsel = $("#filter-lang");
  if (lsel) {
    const counts = {};
    for (const e of _exploreAll) { const id = canonLangId(entryLang(e)); counts[id] = (counts[id] || 0) + 1; }
    const langs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    lsel.innerHTML = `<option value="">${t("exp.f.lang.all")}</option>` +
      langs.map(([id, c]) => `<option value="${escapeHtml(id)}">${escapeHtml(_langNameById(id))} (${c})</option>`).join("");
    // La valeur reflète le scope courant (défini au chargement = langue de l'utilisateur).
    lsel.value = (_exploreLangFilter && counts[_exploreLangFilter]) ? _exploreLangFilter : "";
    _exploreLangFilter = lsel.value;        // resynchronise si la langue n'a aucune contribution
  }
  refreshEnhancedSelects();               // les filtres sont déjà habillés (auto) → resync
}
/** Clé de normalisation (casse/espaces ignorés) pour regrouper un même mot. */
function _normKey(s) { return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " "); }
/** Regroupe les contributions par (sens + texte source normalisé) = un headword. */
function buildGroups(entries) {
  const map = new Map();
  for (const e of entries) {
    const dc = dirCanon(e);
    const key = dc + "::" + _normKey(e.source_text);
    let g = map.get(key);
    if (!g) { g = { key, direction: dc, source_text: e.source_text || "", entries: [], _srcCount: {} }; map.set(key, g); }
    g.entries.push(e);
    // texte affiché = la casse d'origine la plus fréquente
    const sv = e.source_text || "";
    g._srcCount[sv] = (g._srcCount[sv] || 0) + 1;
    if (g._srcCount[sv] > (g._srcCount[g.source_text] || 0)) g.source_text = sv;
  }
  return [...map.values()];
}
function isPlayable(u) { return !!u && /^https?:\/\/|^data:audio\//i.test(u); }
function groupStats(g) {
  const villages = new Set(), contributors = new Set();
  let audios = 0, translations = 0;
  for (const e of g.entries) {
    if (e.variante) villages.add(e.variante);
    if (e.credit) contributors.add(e.credit);
    if (isPlayable(e.audio_url)) audios++;
    if (e.target_text) translations++;
  }
  return { props: g.entries.length, villages: [...villages].sort(), contributors: contributors.size, audios, translations };
}
/** Village du lecteur (depuis son profil), pour signaler les variantes d'ailleurs. */
function viewerVillage() { return (loadContributeur().village || "").trim(); }
/** Consensus PAR VILLAGE : la traduction la plus corroborée par des contributions
    indépendantes. Confirmé si ≥2 concordantes ET strictement devant la 2ᵉ. */
function villageConsensus(entries) {
  const tally = new Map();
  for (const e of entries) {
    const t = e.target_text; if (!t) continue;
    const k = _normKey(t);
    let o = tally.get(k); if (!o) { o = { text: t, count: 0 }; tally.set(k, o); }
    o.count++;
  }
  const arr = [...tally.values()].sort((a, b) => b.count - a.count);
  const confirmed = arr.length > 0 && arr[0].count >= 2 && (arr.length === 1 || arr[0].count > arr[1].count);
  return { winner: arr[0] || null, candidates: arr, confirmed };
}
// Positions STYLISÉES des villages ngiemboon (pas une carte GPS) : un agencement
// plaisant, vaguement fidèle à la géographie des Bamboutos (Bangang au centre-sud).
const VILLAGE_POS = {
  "Bangang": [50, 58], "Batcham": [73, 30], "Balatchi": [82, 52],
  "Bamougong": [47, 24], "Balessing": [24, 66], "Batang": [27, 40],
};
/** Dessine la carte stylisée des variantes à partir des contributions chargées
    (Explorer). Chaque village = un losange Ndop dimensionné par son nombre de
    contributions ; le village du contributeur ressort en laiton. Villages connus
    à position fixe ; les autres (quartiers…) placés en couronne. */
function renderVariantMap() {
  const host = $("#variant-map"); if (!host) return;
  const counts = {};
  for (const e of _exploreEntries) {
    const v = (e.variante || "").trim();
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  const items = Object.entries(counts);
  if (!items.length) { host.hidden = true; host.innerHTML = ""; return; }
  host.hidden = false;
  const mine = viewerVillage();
  // CHAQUE village a SON PROPRE nœud (plus d'agrégat « Autres ») : les villages connus
  // gardent leur position fixe ; les autres (quartiers, villages d'autres langues…) sont
  // placés automatiquement en couronne(s) autour du centre, avec évitement de collision
  // pour qu'aucun losange ni son étiquette ne se chevauchent. Trié par volume décroissant.
  const sorted = items.slice().sort((a, b) => b[1] - a[1]);
  const placed = [];   // {x,y} déjà occupés (pour l'anti-collision)
  const free = (x, y, d) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= d);
  const cx0 = 50, cy0 = 48;                         // centre géométrique du canevas (viewBox 0..96)
  const rings = [{ r: 28, n: 10 }, { r: 41, n: 14 }, { r: 15, n: 6 }];
  const GAP = 17;                                   // écart mini entre 2 centres (anti-chevauchement)
  const nodes = [];
  // 1) villages CONNUS d'abord : ils gardent leur position fixe → on les réserve pour que
  //    les inconnus (placés ensuite) les évitent (aucun chevauchement).
  for (const [v, c] of sorted) {
    if (!VILLAGE_POS[v]) continue;
    const pos = { x: VILLAGE_POS[v][0], y: VILLAGE_POS[v][1] };
    placed.push(pos); nodes.push({ v, c, x: pos.x, y: pos.y, mine: v === mine });
  }
  // 2) villages INCONNUS : première place libre en couronne autour du centre.
  let ui = 0;
  for (const [v, c] of sorted) {
    if (VILLAGE_POS[v]) continue;
    let pos = null;
    for (const ring of rings) {
      for (let k = 0; k < ring.n && !pos; k++) {
        const a = (k / ring.n) * Math.PI * 2 + ui * 0.618;   // décalage doré : positions variées
        const x = cx0 + ring.r * Math.cos(a), y = cy0 + ring.r * 0.74 * Math.sin(a);
        if (x >= 10 && x <= 90 && y >= 9 && y <= 87 && free(x, y, GAP)) pos = { x, y };
      }
      if (pos) break;
    }
    if (!pos) { const a = ui * 1.3; pos = { x: cx0 + 33 * Math.cos(a), y: cy0 + 26 * Math.sin(a) }; }
    ui++;
    placed.push(pos); nodes.push({ v, c, x: pos.x, y: pos.y, mine: v === mine });
  }
  const max = Math.max.apply(null, nodes.map((n) => n.c));
  const cx = (VILLAGE_POS["Bangang"] || [50, 58])[0], cy = (VILLAGE_POS["Bangang"] || [50, 58])[1];
  const links = nodes.map((n) =>
    `<line x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" style="stroke:var(--gold)" stroke-opacity="0.16" stroke-width="0.45"/>`
  ).join("");
  const diamonds = nodes.map((n) => {
    const r = (2.0 + 3.2 * Math.sqrt(n.c / max)).toFixed(2);
    const fill = n.mine ? "var(--gold)" : "var(--cyan)";
    const stroke = n.mine ? "var(--gold)" : "var(--green)";
    // Nœud CLIQUABLE : filtre la liste sur ce village (le « lien » qui va avec chacun).
    return `<g class="vmap-node" data-village="${escapeHtml(n.v)}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})" role="button" tabindex="0" aria-label="${escapeHtml(n.v)} (${n.c})" style="cursor:pointer">
      <rect x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" rx="0.7" transform="rotate(45)"
        style="fill:${fill};stroke:${stroke}" fill-opacity="${n.mine ? 0.92 : 0.72}" stroke-width="0.5"/>
      <text x="0" y="1" text-anchor="middle" font-size="2.7" font-weight="700" style="fill:#06121a">${n.c}</text>
      <text x="0" y="${(+r + 3.8).toFixed(1)}" text-anchor="middle" font-size="3" font-weight="600" style="fill:var(--text)">${escapeHtml(n.v)}</text>
    </g>`;
  }).join("");
  host.innerHTML = `<div class="vmap-head">${t("exp.vmap.head")}</div>
    <div class="vmap-sub">${t("exp.vmap.sub")}${mine ? t("exp.vmap.sub.mine") : ""}.</div>
    <svg viewBox="0 0 100 96" class="vmap-svg" role="img" aria-label="${t("exp.vmap.aria")}">
      ${links}${diamonds}
    </svg>${topContributorsHtml()}`;
}
function renderExplore() {
  _openGroupKey = null;
  if (isKbOpen()) hideKeyboard();     // le champ ciblé (proposition) va disparaître
  const list = $("#explore-list"), status = $("#explore-status");
  if (!list) return;
  renderVariantMap();                 // carte stylisée des variantes (d'où viennent les contributions)
  const q = ($("#explore-search") ? $("#explore-search").value : "").trim().toLowerCase();
  const fd = $("#filter-direction") ? $("#filter-direction").value : "";
  const fr = $("#filter-role") ? $("#filter-role").value : "";
  const fv = $("#filter-variante") ? $("#filter-variante").value : "";
  const fdom = $("#filter-domaine") ? $("#filter-domaine").value : "";
  const match = (e) => {
    if (fd && dirOrient(e.direction) !== dirOrient(fd)) return false;
    if (fr && e.role !== fr) return false;
    if (fv && e.variante !== fv) return false;
    if (fdom && e.domaine !== fdom) return false;
    if (q) {
      const hay = ((e.source_text || "") + " " + (e.target_text || "") + " " + (e.note || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
  // Les groupes sont bâtis sur TOUTES les entrées (métriques + détail complets) ;
  // les filtres décident seulement quels cadres apparaissent.
  _exploreGroups = buildGroups(_exploreEntries);
  const visKeys = new Set(_exploreEntries.filter(match).map((e) => dirCanon(e) + "::" + _normKey(e.source_text)));
  const groups = _exploreGroups.filter((g) => visKeys.has(g.key))
    .sort((a, b) => b.entries.length - a.entries.length || _normKey(a.source_text).localeCompare(_normKey(b.source_text)));
  if (status) status.textContent = ti(groups.length > 1 ? "exp.count.many" : "exp.count.one", { n: groups.length }) +
    (groups.length !== _exploreGroups.length ? ti("exp.count.of", { t: _exploreGroups.length }) : "");
  if (groups.length === 0) {
    const emsg = _exploreEntries.length === 0
      ? (currentLang() ? ti("exp.empty.lang", { lang: escapeHtml(currentLang().nom) }) : t("exp.empty.search"))
      : t("exp.empty.search");
    list.innerHTML = `<div class="explore-empty"><img class="empty-illus" src="icons/empty-explore.webp" alt="" aria-hidden="true"><div class="empty-msg">${emsg}</div></div>`;
    return;
  }
  list.className = "explore-groups";
  list.innerHTML = groups.map(renderGroupCard).join("");
}
/** Extrait l'ID de fichier Drive d'un lien (…?id=XXX ou /d/XXX/…). */
function driveFileId(url) {
  const m = /[?&]id=([A-Za-z0-9_-]+)/.exec(url || "") || /\/d\/([A-Za-z0-9_-]+)/.exec(url || "");
  return m ? m[1] : "";
}
/** Lecteur audio : rendu du <audio> natif, enrichi ensuite par enhanceAudioPlayers
    qui garantit une écoute DANS l'app (jamais de téléchargement manuel). */
function playableAudio(url, durMs) {
  if (!isPlayable(url)) return "";
  const u = escapeHtml(url);
  const did = driveFileId(url);
  // Durée RÉELLE (mesurée à l'enregistrement) transmise au lecteur : le navigateur
  // annonce une durée fausse pour le WebM/Opus, donc on ne s'y fie pas.
  const dm = Math.round(Number(durMs));
  const dur = (isFinite(dm) && dm > 0) ? ` data-audio-dur="${dm}"` : "";
  return `<div class="entry-audio" data-audio-src="${u}"${did ? ` data-drive-id="${escapeHtml(did)}"` : ""}${dur}>
    <audio controls preload="metadata" src="${u}"></audio>
    <span class="entry-audio-status" data-role="audio-status" hidden></span>
  </div>`;
}
/** Rend chaque lecteur écoutable DANS l'app, par escalade automatique et
    transparente : (1) lecture directe du lien ; si elle échoue (2) on récupère
    l'audio en mémoire (fetch → Blob → lecture locale) ; si le fetch est bloqué
    (CORS Drive) (3) on bascule sur le lecteur intégré Google Drive (iframe), qui
    lit les fichiers « accessibles par lien » sans téléchargement. L'utilisateur
    n'a jamais à télécharger ni ouvrir quoi que ce soit lui-même. */
function enhanceAudioPlayers(root) {
  (root || document).querySelectorAll(".entry-audio:not([data-enh])").forEach((box) => {
    box.dataset.enh = "1";
    const audio = box.querySelector("audio");
    if (!audio) return;
    const src = box.dataset.audioSrc, driveId = box.dataset.driveId;
    const status = box.querySelector("[data-role='audio-status']");
    mountAudioPlayer(box, audio);          // habille le <audio> d'un lecteur sur-mesure
    const setStatus = (t) => { if (status) { status.hidden = !t; status.textContent = t || ""; } };
    if (driveId) {
      // AUDIO DRIVE : la lecture directe cross-origin est impossible (Drive ne renvoie
      // pas d'en-têtes CORS et sert ses fichiers en « pièce jointe »). On TÉLÉCHARGE
      // donc le son via le script Google (seul à pouvoir lire Drive), puis on le joue
      // LOCALEMENT (blob) dans le lecteur sur-mesure. JAMAIS d'affichage « classique ».
      audio.removeAttribute("src");
      loadDriveAudioInto(audio, driveId, setStatus);
      return;
    }
    // Non-Drive (serveur local /audio, data:) : lecture directe ; blob de secours au besoin.
    let triedBlob = false;
    async function escalate() {
      if (!triedBlob) {
        triedBlob = true; setStatus(t("audio.loading.full"));
        try {
          const r = await fetch(src, { mode: "cors" });
          if (r.ok) { const b = await r.blob(); audio.src = URL.createObjectURL(b); audio.load(); setStatus(""); return; }
        } catch (e) { /* échec */ }
      }
      setStatus(t("audio.unavail"));
    }
    audio.addEventListener("error", escalate);
  });
}
// Cache des sons Drive déjà téléchargés (fileId → URL de blob local) : re-jouer un
// enregistrement ne le re-télécharge pas.
const _driveAudioBlob = new Map();
/** Télécharge un son Drive (via le script Google) et l'installe comme source locale. */
async function loadDriveAudioInto(audio, fileId, setStatus) {
  const cached = _driveAudioBlob.get(fileId);
  if (cached) { audio.src = cached; audio.load(); if (setStatus) setStatus(""); return; }
  if (setStatus) setStatus(t("audio.loading.full"));
  try {
    const data = await fetchDriveAudio(fileId);
    if (data && data.ok && data.b64) {
      const bin = atob(data.b64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: data.mime || "audio/webm" }));
      _driveAudioBlob.set(fileId, url);
      audio.src = url; audio.load();
      if (setStatus) setStatus("");
      return;
    }
  } catch (e) { /* endpoint absent (script non redéployé) ou échec réseau */ }
  if (setStatus) setStatus(t("audio.unavail"));
}
function dirLabel(d) {
  const l2fr = dirOrient(d) === "l2fr";
  // code = le jeton non-FR de la direction (« fr2bas » → bas, « bas2fr » → bas) ; repli langue courante
  const raw = l2fr ? String(d || "").slice(0, -3) : String(d || "").slice(3);
  const code = canonLangId(raw || getCurrentLangId()).slice(0, 3).toUpperCase();
  return l2fr ? `${code} → FR` : `FR → ${code}`;
}
/** NIVEAU 1 — un cadre par mot/expression, avec métriques agrégées. */
function renderGroupCard(g) {
  const st = groupStats(g);
  const mine = viewerVillage();
  const mineEntries = mine ? g.entries.filter((e) => _normKey(e.variante) === _normKey(mine)) : [];
  const vc = mineEntries.length ? villageConsensus(mineEntries) : null;
  let consensus;
  if (vc && vc.confirmed)
    consensus = `<span class="grp-consensus is-ok">✅ ${t("exp.cons.your")} (${escapeHtml(mine)}) : <b>${escapeHtml(vc.winner.text)}</b></span>`;
  else if (st.villages.length > 1)
    consensus = `<span class="grp-consensus">🔎 ${ti("exp.cons.compare", { n: st.villages.length })}</span>`;
  else
    consensus = `<span class="grp-consensus">${st.props > 1 ? t("exp.cons.split") : t("exp.cons.one")}</span>`;
  const vils = st.villages.slice(0, 4).map((v) => `<span class="entry-chip">📍 ${escapeHtml(v)}</span>`).join(" ") +
    (st.villages.length > 4 ? ` <span class="entry-chip">+${st.villages.length - 4}</span>` : "");
  const m = [];
  m.push(`<span class="grp-m" title="${t("exp.m.props")}">🗣 ${st.props}</span>`);
  m.push(`<span class="grp-m" title="${t("exp.m.villages")}">📍 ${st.villages.length}</span>`);
  if (st.translations) m.push(`<span class="grp-m" title="${t("exp.m.written")}">✍️ ${st.translations}</span>`);
  if (st.audios) m.push(`<span class="grp-m" title="${t("exp.m.audio")}">🎙 ${st.audios}</span>`);
  return `<article class="grp-card" data-key="${escapeHtml(g.key)}" role="button" tabindex="0"
      aria-label="${escapeHtml(ti("exp.open.aria", { x: g.source_text || "" }))}">
    <div class="grp-head">
      <span class="grp-word">${escapeHtml(g.source_text || "…")}</span>
      <span class="badge-dir">${dirLabel(g.direction)}</span>
    </div>
    <div class="grp-metrics">${m.join("")}</div>
    <div class="grp-villages">${vils}</div>
    <div class="grp-foot">${consensus}<span class="grp-open">${t("exp.open")}</span></div>
  </article>`;
}
/** Passe au NIVEAU 2 — détail d'un mot. */
function openGroup(key) {
  const g = _exploreGroups.find((x) => x.key === key);
  if (!g) return;
  if (isKbOpen()) hideKeyboard();
  _openGroupKey = key;
  renderGroupDetail(g);
  const list = $("#explore-list"); if (list) list.scrollIntoView({ behavior: "smooth", block: "start" });
}
/** Avertissement de variante : compare le village d'une proposition à celui du lecteur. */
function villageNote(village) {
  const mine = viewerVillage();
  if (!village) return "";
  if (!mine)
    return `<div class="vil-note vil-neutral">${ti("exp.vil.neutral", { v: escapeHtml(village) })}</div>`;
  if (_normKey(village) === _normKey(mine))
    return `<div class="vil-note vil-same">${ti("exp.vil.same", { v: escapeHtml(village) })}</div>`;
  return `<div class="vil-note vil-diff">${ti("exp.vil.diff", { v: escapeHtml(village), mine: escapeHtml(mine) })}</div>`;
}
/** NIVEAU 2 — le détail d'un mot : propositions regroupées par village. */
function renderGroupDetail(g) {
  const list = $("#explore-list"); if (!list) return;
  const byVil = new Map();
  for (const e of g.entries) {
    const v = e.variante || t("exp.vil.unspecified");
    if (!byVil.has(v)) byVil.set(v, []);
    byVil.get(v).push(e);
  }
  // Le village du lecteur d'abord, puis les autres par ordre alpha.
  const mine = viewerVillage();
  const order = [...byVil.keys()].sort((a, b) => {
    const am = _normKey(a) === _normKey(mine), bm = _normKey(b) === _normKey(mine);
    if (am !== bm) return am ? -1 : 1;
    return a.localeCompare(b);
  });
  const hasText = g.entries.some((e) => e.target_text);
  const hasAudio = g.entries.some((e) => isPlayable(e.audio_url));
  let missing = "";
  if (hasText && !hasAudio)
    missing = `<div class="grp-missing">${t("exp.missing.audio")}</div>`;
  else if (hasAudio && !hasText)
    missing = `<div class="grp-missing">${t("exp.missing.text")}</div>`;
  const blocks = order.map((v) => renderVillageBlock(v, byVil.get(v))).join("");
  list.className = "explore-detail";
  list.innerHTML = `<div class="grp-detail">
    <button type="button" class="grp-back">${t("exp.detail.back")}</button>
    <div class="grp-detail-head">
      <span class="grp-word">${escapeHtml(g.source_text || "…")}</span>
      <span class="badge-dir">${dirLabel(g.direction)}</span>
    </div>
    <p class="grp-intro">${t("exp.detail.intro")}</p>
    ${missing}
    ${blocks}
  </div>`;
  enhanceAudioPlayers(list);        // écoute directe dans l'app (jamais de téléchargement)
}
/** Un village = son consensus (corroboration) + l'avertissement + ses propositions. */
function renderVillageBlock(village, ents) {
  const vc = villageConsensus(ents);
  const note = village === t("exp.vil.unspecified") ? "" : villageNote(village);
  const nTxt = ents.filter((e) => e.target_text).length;
  const consensus = vc.confirmed
    ? `<div class="corr-consensus">${ti("exp.ref", { v: escapeHtml(village) })}
        <span class="corr-win">${escapeHtml(vc.winner.text)}</span>
        <span class="corr-wvotes">${ti("exp.concordant", { n: vc.winner.count })}</span></div>`
    : (nTxt > 1 ? `<div class="corr-noconsensus">${ti("exp.diverging", { v: escapeHtml(village) })}</div>` : "");
  return `<section class="vil-block">
    <div class="vil-title">📍 ${escapeHtml(village)} <span class="vil-count">${ents.length} ${t("exp.props")}${ents.length > 1 ? "s" : ""}</span></div>
    ${note}
    ${consensus}
    ${ents.map(renderProposal).join("")}
  </section>`;
}
/** Une proposition individuelle (réutilise le panneau de corrections v51). */
function renderProposal(e) {
  const chips = [];
  if (e.role) chips.push(`<span class="entry-chip">🗣 ${escapeHtml(roleLabel(e.role))}</span>`);
  if (e.domaine) chips.push(`<span class="entry-chip">🏷 ${escapeHtml(e.domaine)}</span>`);
  const audio = playableAudio(e.audio_url, e.audio_duree_ms);
  const note = e.note ? `<span class="entry-note">« ${escapeHtml(e.note)} »</span>` : "";
  const credit = `<span class="entry-credit">✍️ ${e.credit ? escapeHtml(e.credit) : t("exp.anon")}</span>`;
  const date = e.date ? `<span class="entry-date">${escapeHtml(e.date)}</span>` : "";
  const tgt = e.target_text
    ? `<span class="entry-tgt">${escapeHtml(e.target_text)}</span>`
    : `<span class="entry-tgt entry-tgt--empty">${t("exp.audio.only")}</span>`;
  return `<article class="entry entry--prop">
    <div class="entry-pair">${tgt}</div>
    ${chips.length || note ? `<div class="entry-meta">${chips.join(" ")} ${note}</div>` : ""}
    ${audio}
    <div class="entry-foot">${credit} ${date}</div>
    ${voteBarHtml(e)}
    <div class="entry-actions">
      <button type="button" class="entry-improve" data-id="${escapeHtml(e.id)}" data-orig="${escapeHtml(e.target_text || "")}"><img class="act-ico" src="icons/ni-suggestion.png" alt="" aria-hidden="true">${t("exp.improve")}</button>
      <button type="button" class="entry-saymine" data-fr="${escapeHtml(dirOrient(e.direction) === "l2fr" ? (e.target_text || e.source_text || "") : (e.source_text || ""))}" title="${t("exp.saymine.title")}">${t("exp.saymine")}</button>
      <button type="button" class="entry-share" data-src="${escapeHtml(e.source_text || "")}" data-tgt="${escapeHtml(e.target_text || "")}" data-dir="${escapeHtml(dirCanon(e))}" data-audio="${isPlayable(e.audio_url) ? "1" : "0"}" title="${t("exp.share.title")}" aria-label="${t("exp.share.aria")}"><img class="act-ico" src="icons/ni-share.png" alt="" aria-hidden="true">${t("exp.share")}</button>
    </div>
    <div class="entry-corr" hidden></div>
  </article>`;
}

// --- Vote communautaire à 3 états (juste ✓ / doute ? / faux ✗) --------------
// Un locuteur laisse UN vote par proposition, qu'il peut changer ou ANNULER (re-clic
// sur son choix). La pastille montre les comptes des 3 états ; son propre choix ressort.
const VOTE_KINDS = [["ok", "✓", "ok"], ["doubt", "?", "doubt"], ["no", "✗", "no"]];
function voteBarHtml(e) {
  const v = e.votes3 || { ok: 0, doubt: 0, no: 0 };
  const mine = e.my_vote || "";
  const btns = VOTE_KINDS.map(([val, sym, cls]) =>
    `<button type="button" class="ev-btn ev-${cls}${mine === val ? " is-mine" : ""}" data-v="${val}" data-id="${escapeHtml(e.id)}"
       title="${t("vote." + val + ".title")}" aria-pressed="${mine === val}">${sym} <b class="ev-n">${(v[val] || 0)}</b></button>`).join("");
  return `<div class="entry-vote" role="group" aria-label="${t("vote.aria")}"><span class="ev-lbl"><img class="act-ico act-ico--vote" src="icons/ni-vote.png" alt="" aria-hidden="true">${t("vote.lbl")}</span>${btns}</div>`;
}
function _voteCounts(bar) {
  const o = {};
  bar.querySelectorAll(".ev-btn").forEach((b) => { o[b.dataset.v] = parseInt((b.querySelector(".ev-n") || {}).textContent || "0", 10) || 0; });
  return o;
}
function _applyVoteBar(bar, counts, mine) {
  bar.querySelectorAll(".ev-btn").forEach((b) => {
    const v = b.dataset.v, n = b.querySelector(".ev-n");
    if (n) n.textContent = counts[v] || 0;
    b.classList.toggle("is-mine", mine === v);
    b.setAttribute("aria-pressed", mine === v);
  });
}
async function onVote3(btn) {
  if (!profileComplete()) { toast(t("vote.needprofile"), "warn"); openProfile(true); return; }
  const bar = btn.closest(".entry-vote"); if (!bar) return;
  const id = btn.dataset.id, val = btn.dataset.v;
  const cur = bar.querySelector(".ev-btn.is-mine");
  const curVal = cur ? cur.dataset.v : "";
  const newVal = (curVal === val) ? "" : val;    // re-clic sur son choix = ANNULATION
  // Mise à jour OPTIMISTE (réactivité) : on ajuste les comptes localement.
  const counts = _voteCounts(bar);
  if (curVal) counts[curVal] = Math.max(0, (counts[curVal] || 0) - 1);
  if (newVal) counts[newVal] = (counts[newVal] || 0) + 1;
  _applyVoteBar(bar, counts, newVal);
  try {
    const r = await postVote({ id_cible: id, device_id: deviceId(), valeur: newVal, credit: creditDisplay() });
    if (r && r.votes) _applyVoteBar(bar, r.votes, r.my_vote || "");   // réconcilie avec le serveur
  } catch (e) { toast(t("vote.fail"), "warn"); }
}

// --- Corrections communautaires + consensus (par entrée) -------------------
function onExploreClick(e) {
  const back = e.target.closest(".grp-back");
  if (back) { renderExplore(); return; }
  const imp = e.target.closest(".entry-improve");
  if (imp) { toggleCorrections(imp.closest(".entry"), imp.dataset.id, imp.dataset.orig); return; }
  const shr = e.target.closest(".entry-share");
  if (shr) { shareEntry(shr.dataset.src, shr.dataset.tgt, shr.dataset.dir, shr.dataset.audio === "1"); return; }
  const sm = e.target.closest(".entry-saymine");
  if (sm) { startTranslateWord(sm.dataset.fr); return; }
  const ev = e.target.closest(".ev-btn");
  if (ev) { onVote3(ev); return; }
  // clic sur un cadre de mot (mais pas sur un bouton interne) → détail
  const card = e.target.closest(".grp-card");
  if (card) { openGroup(card.dataset.key); return; }
  const kb = e.target.closest("[data-role='corr-kb']");
  if (kb) {
    const ctxt = kb.closest("[data-role='corr-text-wrap']").querySelector("[data-role='corr-text']");
    if (ctxt) openKeyboardFor(ctxt);
    return;
  }
  const rec = e.target.closest("[data-role='corr-rec']");
  if (rec) { onCorrRec(rec); return; }
  const vote = e.target.closest(".corr-vote");
  if (vote) { onVote(vote); return; }
  const sub = e.target.closest(".corr-submit");
  if (sub) { onProposeSubmit(sub); return; }
}
/** Changement du type de proposition (texte/audio/commentaire) → UI adaptée. */
function onExploreChange(e) {
  const t = e.target;
  if (t && t.dataset && t.dataset.role === "corr-type") applyCorrType(t.closest(".entry-corr"));
}
/** Gagnant du consensus : mieux voté si ≥ SEUIL et strictement devant le 2e. */
function consensusOf(cands) {
  const SEUIL = 2;
  const s = [...cands].sort((a, b) => b.votes - a.votes);
  if (s.length && s[0].votes >= SEUIL && (s.length === 1 || s[0].votes > s[1].votes)) return s[0];
  return null;
}
async function toggleCorrections(entryEl, id, origText) {
  const panel = entryEl.querySelector(".entry-corr");
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<div class="corr-loading">' + t("corr.loading") + '</div>';
  try { renderCorrections(panel, id, origText, await fetchSuggestions(id)); }
  catch (e) { panel.innerHTML = '<div class="corr-empty">Impossible de charger les corrections (connexion ?).</div>'; }
}
async function reloadCorrections(entryEl) {
  const imp = entryEl.querySelector(".entry-improve");
  const panel = entryEl.querySelector(".entry-corr");
  if (!imp || !panel) return;
  try { renderCorrections(panel, imp.dataset.id, imp.dataset.orig, await fetchSuggestions(imp.dataset.id)); }
  catch (e) { /* garde l'affichage courant */ }
}
function renderCorrections(panel, id, origText, data) {
  if (isKbOpen() && _kbField && panel.contains(_kbField)) hideKeyboard();  // ancien champ va être remplacé
  const sugg = (data && data.suggestions) || [];
  const origVotes = (data && data.orig_votes) || 0;
  const isText = (t) => t === "texte" || t === "correction" || t === "alternative";
  const textAlts = sugg.filter((s) => isText(s.type) && s.texte);
  const audioAlts = sugg.filter((s) => s.audio && /^https?:\/\//i.test(s.audio));
  const comments = sugg.filter((s) => s.type === "commentaire" && !s.audio && s.texte);
  // Consensus sur le TEXTE : original + alternatives textuelles.
  const cands = [{ id: "orig:" + id, texte: origText || "…", votes: origVotes, isOrig: true }]
    .concat(textAlts.map((s) => ({ id: s.id, texte: s.texte, votes: s.votes })));
  const win = consensusOf(cands);
  const winHtml = win
    ? `<div class="corr-consensus">${t("corr.community")}
        <span class="corr-win">${escapeHtml(win.texte)}</span>
        <span class="corr-wvotes">${win.votes} ${t("corr.vote")}${win.votes > 1 ? "s" : ""}</span></div>`
    : (textAlts.length ? `<div class="corr-noconsensus">${t("corr.noconsensus")}</div>` : "");
  const candHtml = cands.length > 1
    ? `<div class="corr-sub">${t("corr.sub.translations")}</div>` + [...cands].sort((a, b) => b.votes - a.votes).map((c) =>
        `<div class="corr-cand${win && c.id === win.id ? " is-win" : ""}">
          <span class="corr-cand-txt">${escapeHtml(c.texte)}${c.isOrig ? ` <span class="corr-tag">${t("corr.original")}</span>` : ""}</span>
          <button type="button" class="corr-vote" data-cible="${escapeHtml(c.id)}"><img class="act-ico" src="icons/ni-vote.png" alt="" aria-hidden="true">${c.votes}</button>
        </div>`).join("")
    : "";
  const audioHtml = audioAlts.length
    ? `<div class="corr-sub">${t("corr.sub.audio")}</div>` + audioAlts.map((s) =>
        `<div class="corr-cand">
          <span class="corr-cand-txt">${playableAudio(s.audio, s.duree_ms || s.audio_duree_ms)}${s.credit ? ` <span class="corr-credit">· ${escapeHtml(s.credit)}</span>` : ""}</span>
          <button type="button" class="corr-vote" data-cible="${escapeHtml(s.id)}"><img class="act-ico" src="icons/ni-vote.png" alt="" aria-hidden="true">${s.votes}</button>
        </div>`).join("")
    : "";
  const comHtml = comments.length
    ? `<div class="corr-sub">${t("corr.sub.comments")}</div>` + comments.map((c) =>
        `<div class="corr-com">💬 ${escapeHtml(c.texte)}${c.credit ? ` <span class="corr-credit">· ${escapeHtml(c.credit)}</span>` : ""}</div>`).join("")
    : "";
  const form = `<div class="corr-form">
      <div class="corr-sub">${t("corr.sub.propose")}</div>
      <div class="corr-form-row">
        <select class="corr-type" data-role="corr-type" aria-label="${t("corr.type.aria")}">
          <option value="texte">${t("corr.opt.text")}</option>
          <option value="audio">${t("corr.opt.audio")}</option>
          <option value="commentaire">${t("corr.opt.comment")}</option>
        </select>
      </div>
      <div class="corr-text-wrap" data-role="corr-text-wrap">
        <input type="text" class="corr-text" data-role="corr-text" inputmode="none" placeholder="${t("corr.ph.alt")}" autocomplete="off" />
        <button type="button" class="corr-kb-btn" data-role="corr-kb">${t("corr.kb")}</button>
      </div>
      <div class="corr-audio-wrap" data-role="corr-audio-wrap" hidden>
        <button type="button" class="btn btn--rec corr-rec" data-role="corr-rec">${t("corr.rec")}</button>
        <span class="rec-timer corr-rec-timer" data-role="corr-timer" hidden>00:00</span>
        <span class="corr-rec-preview" data-role="corr-preview"></span>
      </div>
      <button type="button" class="corr-submit" data-entry="${escapeHtml(id)}">${t("corr.submit")}</button>
    </div>`;
  panel.innerHTML = winHtml + candHtml + audioHtml + comHtml + form;
  // Le <select> « type » est habillé automatiquement par l'observateur.
  enhanceAudioPlayers(panel);        // écoute directe des prononciations proposées
  // Le champ « proposer une traduction » ouvre le CLAVIER NGIEMBOON (pas le clavier OS).
  const ctxt = panel.querySelector("[data-role='corr-text']");
  if (ctxt) attachKbTap(ctxt, () => { if (ctxt.getAttribute("inputmode") === "none") openKeyboardFor(ctxt); });
}
async function onVote(btn) {
  if (!requireProfile(t("vote.needprofile"))) return;   // voter = écrire → profil exigé
  btn.disabled = true;
  try {
    await postVote({ id_cible: btn.dataset.cible, device_id: deviceId(), valeur: 1 });
    await reloadCorrections(btn.closest(".entry"));
  } catch (e) { btn.disabled = false; toast(t("toast.vote.fail"), "warn"); }
}
async function onProposeSubmit(btn) {
  const panel = btn.closest(".entry-corr");
  const sel = panel.querySelector(".corr-form select");   // masqué (sr-only) → par balise
  const type = (sel && sel.value) || "texte";
  if (!profileComplete()) { toast(t("toast.propose.profile"), "warn"); openProfile(true); return; }
  const c = loadContributeur();
  const base = {
    id_contribution: btn.dataset.entry, type,
    credit_display: c.credit_display || "", device_id: deviceId(),
    client_id: (crypto.randomUUID && crypto.randomUUID()) || "s-" + Date.now(),
  };
  let payload;
  if (type === "audio") {
    if (!panel._corrBlob) { toast(t("toast.propose.audio"), "warn"); return; }
    payload = Object.assign(base, {
      audio_base64: await blobToBase64Corr(panel._corrBlob),
      audio: { present: true, format: panel._corrBlob.type || "audio/webm", duree_ms: panel._corrDur || 0 },
    });
  } else {
    const inp = panel.querySelector("[data-role='corr-text']");
    const texte = nfc(inp ? inp.value.trim() : "");
    if (!texte) { toast(t("toast.propose.text"), "warn"); return; }
    payload = Object.assign(base, { texte });
  }
  btn.disabled = true;
  try {
    await postSuggestion(payload);
    panel._corrBlob = null; panel._corrDur = 0;
    await reloadCorrections(panel.closest(".entry"));
    toast(t("toast.propose.ok"), "ok");
  } catch (e) { btn.disabled = false; toast(t("toast.send.fail"), "warn"); }
}
function blobToBase64Corr(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
/** Adapte le formulaire au type choisi : texte vs audio (vs commentaire = texte court). */
function applyCorrType(panel) {
  if (!panel) return;
  const sel = panel.querySelector(".corr-form select");
  const type = sel ? sel.value : "texte";
  const tw = panel.querySelector("[data-role='corr-text-wrap']");
  const aw = panel.querySelector("[data-role='corr-audio-wrap']");
  if (tw) tw.hidden = (type === "audio");
  if (aw) aw.hidden = (type !== "audio");
  const inp = panel.querySelector("[data-role='corr-text']");
  const kbBtn = panel.querySelector("[data-role='corr-kb']");
  const isComment = (type === "commentaire");
  if (inp) {
    inp.placeholder = isComment ? t("corr.ph.comment") : t("corr.ph.alt");
    // Traduction ngiemboon → clavier ngiemboon (inputmode none) ; commentaire (FR)
    // → clavier normal du téléphone.
    if (isComment) {
      inp.removeAttribute("inputmode");
      if (isKbOpen() && _kbField === inp) hideKeyboard();
    } else {
      inp.setAttribute("inputmode", "none");
    }
  }
  if (kbBtn) kbBtn.hidden = isComment;
}
// --- Mini-enregistreur pour les corrections (indépendant du principal) ---
let _corrRec = null, _corrChunks = [], _corrTimerInt = null, _corrStartTs = 0;
async function onCorrRec(btn) {
  if (!requireProfile("Crée ton profil pour proposer une prononciation.")) return;   // écrire = profil exigé
  const panel = btn.closest(".entry-corr");
  if (_corrRec && _corrRec.state === "recording") { _corrRec.stop(); return; }
  try {
    const stream = await acquireMicStream();
    _corrChunks = [];
    _corrRec = new MediaRecorder(stream);
    _corrRec.ondataavailable = (ev) => { if (ev.data.size) _corrChunks.push(ev.data); };
    _corrRec.onstop = () => {
      const blob = new Blob(_corrChunks, { type: _corrRec.mimeType || "audio/webm" });
      panel._corrBlob = blob; panel._corrDur = Date.now() - _corrStartTs;
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("is-recording"); btn.textContent = t("corr.rec.redo");
      const t = panel.querySelector("[data-role='corr-timer']"); if (t) t.hidden = true;
      clearInterval(_corrTimerInt);
      const prev = panel.querySelector("[data-role='corr-preview']");
      if (prev) mountLocalAudioPlayer(prev, URL.createObjectURL(blob), panel._corrDur || 0);
    };
    _corrStartTs = Date.now();
    _corrRec.start();
    btn.classList.add("is-recording"); btn.textContent = t("corr.rec.stop");
    const t = panel.querySelector("[data-role='corr-timer']");
    if (t) { t.hidden = false; t.textContent = "00:00"; clearInterval(_corrTimerInt); _corrTimerInt = setInterval(() => { t.textContent = fmtRec(Date.now() - _corrStartTs); }, 250); }
  } catch (e) {
    toast(micAdvice(e.name, "", "?"), "warn");
  }
}

/** Bouton « Continuer / Enregistrer » de la vue profil. */
function updateProfileGate() {
  const ok = profileComplete();
  const btn = $("#btn-profile-continue"); if (btn) btn.disabled = !ok;
  const lock = $("#profile-lock"); if (lock) lock.hidden = ok;
}

/** Reflet visuel du consentement : halo qui respire tant que non coché,
    boîte verte apaisée une fois coché (guide l'utilisateur sans texte). */
function updateConsentUI() {
  const box = document.querySelector(".field--consent");
  if (box) box.classList.toggle("is-checked", !!$("#c-consent").checked);
}

/** Affiche/masque le choix de format du crédit + aperçu du nom qui apparaîtra. */
function updateCreditUI() {
  const on = $("#c-credit-on").checked;
  const wrap = $("#credit-format-wrap"); if (wrap) wrap.hidden = !on;
  const prev = $("#credit-preview");
  if (prev) {
    const mode = on ? ($("#c-credit-format").value || "prenom") : "none";
    const disp = computeCredit(mode, $("#c-prenom").value, $("#c-nom").value);
    prev.textContent = on
      ? (disp ? ti("credit.preview.as", { name: disp }) : t("credit.preview.hint"))
      : "";
  }
}

/** Thème clair/sombre — clair par défaut ; choix mémorisé et appliqué dès le
    <head> (le bouton ne fait qu'inverser). */
/** #flyer bilingue : sert la bonne version du flyer selon la LANGUE (FR/EN) ET le THÈME
    (clair/sombre) de l'utilisateur → flyer[-en][-clair].jpg/.pdf. */
function updateFlyerLinks() {
  const en = getUiLang() === "en";
  const light = document.documentElement.getAttribute("data-theme") === "light";
  const base = "./flyer/flyer" + (en ? "-en" : "") + (light ? "-clair" : "");
  const img = $("#flyer-img-link"), pdf = $("#flyer-pdf-link");
  if (img) img.href = base + ".jpg";
  if (pdf) pdf.href = base + ".pdf";
}
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("ng-theme", mode); } catch (e) { /* stockage indispo */ }
  updateFlyerLinks();   // le flyer téléchargeable suit le thème (et la langue)
  const btn = $("#theme-toggle");
  if (btn) {
    btn.dataset.active = mode;   // capsule ☀|🌙 : la moitié du mode actif est colorée
    const lbl = mode === "dark" ? t("theme.toLight") : t("theme.toDark");
    btn.setAttribute("aria-label", lbl); btn.title = lbl;
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", mode === "dark" ? "#0a0e14" : "#f4f8fc");
}
function initTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(cur);
  const btn = $("#theme-toggle");
  if (btn) btn.addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(now);
  });
}

/** Boutons de la vue app (garde-fou : la vue app n'est atteinte que profil complet). */
function updateGate() {
  const ok = profileComplete();
  // Vitrine : « Enregistrer » et « Prochain mot » restent CLIQUABLES même sans profil
  // — le clic déclenche alors l'invitation à créer un profil (verrou dans saveContribution).
  // Seul l'ENVOI effectif reste désactivé sans profil.
  ["#btn-save", "#prop-next"].forEach((sel) => { const el = $(sel); if (el) el.disabled = false; });
  const send = $("#btn-send"); if (send) send.disabled = !ok || send.disabled;
  ["#save-lock", "#send-lock"].forEach((sel) => {
    const el = $(sel); if (el) el.hidden = ok;
  });
  updateProfileGate();
}

// --- Liste des contributions : DEUX groupes (envoyés ✅ / à renvoyer ⟳) -----
/** Filtre les listes de contributions (envoyées / à renvoyer) selon la recherche, masque les
    groupes sans résultat et affiche un message si aucune contribution ne correspond. */
function filterSendLists() {
  const q = normSearch(($("#send-search") && $("#send-search").value) || "");
  const all = [...document.querySelectorAll("#list-pending .item, #list-sent .item")];
  all.forEach((li) => { li.hidden = q && !(li.dataset.q || "").includes(q); });
  [["#grp-pending", "#list-pending"], ["#grp-sent", "#list-sent"]].forEach(([g, l]) => {
    const grp = $(g); if (grp) grp.hidden = ![...document.querySelectorAll(l + " .item")].some((li) => !li.hidden);
  });
  const shown = all.filter((li) => !li.hidden).length;
  const nr = $("#send-noresult"); if (nr) nr.hidden = !(q && all.length > 0 && shown === 0);
}
function itemHtml(it, confirmed) {
  const fr2nge = dirOrient(it.direction) === "fr2l";
  const kind = it.audioMeta && it.audioMeta.present
    ? (it.target_text ? "transcription + texte" : "transcription")
    : "traduction";
  const tries = !confirmed && it.attempts ? ` · ${it.attempts} tentative${it.attempts > 1 ? "s" : ""}` : "";
  return `<div class="item-main">` +
    `<span class="pair"><b>${escapeHtml(it.source_text)}</b>` +
    (it.target_text ? `<span class="arrow">→</span>${escapeHtml(it.target_text)}` : "") + `</span>` +
    `<span class="meta">${(() => { const lc = (it.langue || getCurrentLangId()).slice(0, 3).toUpperCase(); return fr2nge ? "FR→" + lc : lc + "→FR"; })()} · ${kind}` +
    `${it.audioMeta && it.audioMeta.present ? " · 🎙" : ""}` +
    `${it.domaine ? " · " + escapeHtml(it.domaine) : ""}${tries}</span>` +
    `</div>` +
    `<div class="item-side">` +
    (confirmed
      ? `<span class="badge badge--sent" title="${t("send.badge.sent.t")}">${t("send.badge.sent")}</span>`
      : `<span class="badge badge--local" title="${t("send.badge.pending.t")}">${t("send.badge.pending")}</span>` +
        `<button class="mini" data-resend="${it.client_id}" title="${t("send.resend.t")}">↻</button>`) +
    `<button class="mini" data-del="${it.client_id}" title="${t("send.del.t")}">✕</button>` +
    `</div>`;
}

async function refresh() {
  const items = (await DB.all()).sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );
  const sent = items.filter((x) => x.status === "sent");
  const pending = items.filter((x) => x.status !== "sent");

  $("#count-sent").textContent = sent.length;
  $("#count-pending").textContent = pending.length;
  $("#count-total").textContent = items.length;
  $("#grp-sent-n").textContent = sent.length;
  $("#grp-pending-n").textContent = pending.length;
  $("#btn-send").disabled = pending.length === 0 || !profileComplete() || _reconcileRunning;

  const grpP = $("#grp-pending"), grpS = $("#grp-sent");
  if (grpP) grpP.hidden = pending.length === 0;
  if (grpS) grpS.hidden = sent.length === 0;

  const fill = (sel, arr, confirmed) => {
    const ul = $(sel); if (!ul) return;
    ul.innerHTML = "";
    for (const it of arr) {
      const li = document.createElement("li");
      li.className = "item item--" + (confirmed ? "sent" : "local");
      li.dataset.q = normSearch((it.source_text || "") + " " + (it.target_text || ""));   // texte cherchable
      li.innerHTML = itemHtml(it, confirmed);
      ul.appendChild(li);
    }
  };
  fill("#list-pending", pending, false);
  fill("#list-sent", sent, true);
  // Champ de recherche : visible dès qu'il y a des contributions ; on ré-applique le filtre courant.
  const ssw = $("#send-search-wrap"); if (ssw) ssw.hidden = items.length === 0;
  filterSendLists();

  document.querySelectorAll("[data-resend]").forEach((b) =>
    b.addEventListener("click", () => { kickReconcile(true); toast(t("toast.resend"), "ok"); })
  );
  document.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (confirm("Supprimer cette contribution ?")) {
        await DB.delete(b.dataset.del);
        await refresh();
      }
    })
  );
}

// --- Envoi ROBUSTE : réconciliation + boucle de renvoi AUTO persistante ------
// La vérité est la base distante. Un « tour » confirme ✅ ce qui y est déjà et
// (re)poste ce qui manque. Tant qu'il reste des items non confirmés, un tour
// est reprogrammé automatiquement (backoff), y compris après rechargement de la
// page et au retour du réseau → tout finit par arriver, sans action de l'user.
let _reconcileRunning = false;
let _reconcileTimer = null;
let _reconcileDelay = 12000;   // délai courant de la boucle (ms)
let _lastToastAllOk = false;

async function reconcileTick() {
  if (_reconcileRunning) return;
  const c0 = await DB.counts();
  if (c0.pending === 0) { _lastToastAllOk = false; return; }
  if (!profileComplete()) return;                    // rien à faire sans profil
  if (!navigator.onLine) {
    setStatus(t("send.offline.auto"));
    scheduleReconcile();
    return;
  }
  _reconcileRunning = true;
  $("#btn-send").disabled = true;
  let res = null;
  try { res = await reconcile((m) => setStatus(m)); } catch (e) { res = null; }
  _reconcileRunning = false;
  await refresh();
  const c1 = await DB.counts();

  if (c1.pending === 0) {
    setStatus("");
    if (!_lastToastAllOk) {
      toast(modeGoogle() ? "Tout est confirmé dans la base ✅"
                         : "Tout est confirmé sur la machine ✅", "ok");
      _lastToastAllOk = true;
    }
  } else {
    _lastToastAllOk = false;
    const progressed = c1.pending < c0.pending;
    _reconcileDelay = progressed ? 8000 : Math.min(Math.round(_reconcileDelay * 1.6), 60000);
    setStatus(`↻ ${c1.pending} en attente de confirmation, renvoi automatique…`);
    if (res && res.sansConfirm && res.echecsListe && res.echecsListe.length) {
      // Ancien backend (sans endpoint confirm) : on informe, la boucle continue.
      const ap = res.echecsListe.slice(0, 5).map((s) => `« ${s} »`).join(", ");
      toast(`${c1.pending} envoi(s) à confirmer : ${ap}${res.echecsListe.length > 5 ? "…" : ""}. Renvoi auto en cours.`, "warn");
    }
  }
  await updateServerBadge();
  scheduleReconcile();
}

/** Programme le prochain tour automatique s'il reste des items non confirmés. */
function scheduleReconcile() {
  clearTimeout(_reconcileTimer);
  DB.counts().then((c) => {
    if (c.pending > 0) _reconcileTimer = setTimeout(reconcileTick, _reconcileDelay);
  }).catch(() => {});
}

/** Relance vite la boucle (nouvel enregistrement, retour réseau, clic renvoyer). */
function kickReconcile() {
  _reconcileDelay = 12000;                 // reset du backoff
  clearTimeout(_reconcileTimer);
  _reconcileTimer = setTimeout(reconcileTick, 500);
}

/** Bouton « Envoyer les données » = déclenche un tour immédiat + assure la boucle. */
async function send() { await reconcileTick(); }

// --- Indicateurs (réseau / serveur) -------------------------------------
async function updateServerBadge() {
  const on = navigator.onLine;
  $("#net").textContent = on ? t("net.online") : t("net.offline");
  $("#net").className = "chip " + (on ? "chip--on" : "chip--off");
  let srv = false;
  try { srv = await checkServer(); } catch (e) { srv = false; }
  const g = modeGoogle();
  $("#srv").textContent = g
    ? (srv ? t("srv.db") : t("net.offline"))
    : (srv ? t("srv.connected") : t("srv.unreachable"));
  $("#srv").className = "chip " + (srv ? "chip--on" : "chip--off");
  const _ss = $("#srv-stats");   // pastille de stats retirée du header : garde-fou si absente
  if (_ss) {
    _ss.textContent = "";
    if (srv && !g) {
      try {
        const st = await serverStats();
        const n = st && st.stores && st.stores[0] ? st.stores[0].count : 0;
        _ss.textContent = n + " enregistrement(s) · " + (st && st.stores ? st.stores.length : 0) + " copies";
      } catch (e) { /* ignore */ }
    }
  }
}

/** Onde lumineuse au clic sur une carte du hub (façon Material) : disque qui se dilate
    depuis le point cliqué. Purement décorative → gelée en prefers-reduced-motion, jamais
    bloquante (try/catch), auto-nettoyée. */
function spawnRipple(card, ev) {
  try {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = card.getBoundingClientRect();
    const x = (ev && ev.clientX ? ev.clientX : r.left + r.width / 2) - r.left;
    const y = (ev && ev.clientY ? ev.clientY : r.top + r.height / 2) - r.top;
    const d = Math.max(r.width, r.height) * 1.7;
    const old = card.querySelector(".hub-ripple"); if (old) old.remove();
    const span = document.createElement("span");
    span.className = "hub-ripple";
    span.style.width = span.style.height = d + "px";
    span.style.left = x + "px"; span.style.top = y + "px";
    card.appendChild(span);
    card.classList.add("is-rippling");
    setTimeout(() => { span.remove(); card.classList.remove("is-rippling"); }, 660);
  } catch (e) { /* décoratif : jamais bloquant */ }
}

// --- Divers --------------------------------------------------------------
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
let toastTimer = null;
function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = tToast(msg);   // traduit en anglais si la langue d'interface est EN
  t.className = "toast toast--" + (kind || "ok") + " is-on";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 4200);
}
/** Micro-célébration : bref halo + confettis losange (cyan/vert/or) jaillissant
    de `originEl` (ou du centre). Sobre, ~1 s, calque retiré après. Respecte
    prefers-reduced-motion (le CSS masque les confettis et raccourcit le halo). */
function celebrate(originEl) {
  try {
    const layer = document.createElement("div");
    layer.className = "celebrate";
    document.body.appendChild(layer);
    const r = originEl && originEl.getBoundingClientRect ? originEl.getBoundingClientRect() : null;
    const cx = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2;
    const cy = r && r.height ? r.top + r.height / 2 : window.innerHeight * 0.4;
    const halo = document.createElement("div");
    halo.className = "halo"; halo.style.left = cx + "px"; halo.style.top = cy + "px";
    layer.appendChild(halo);
    // Illustration « merci » qui apparaît brièvement (uniquement sur une action de l'utilisateur).
    if (originEl) {
      const thanks = document.createElement("img");
      thanks.className = "celebrate-illus"; thanks.src = "icons/celebrate-thanks.webp"; thanks.alt = "";
      thanks.style.left = cx + "px"; thanks.style.top = cy + "px";
      layer.appendChild(thanks);
    }
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      const cols = ["var(--cyan)", "var(--green)", "var(--gold)"];
      for (let i = 0; i < 14; i++) {
        const p = document.createElement("div");
        p.className = "cfd";
        p.style.left = cx + "px"; p.style.top = cy + "px";
        p.style.background = cols[i % 3];
        p.style.setProperty("--dx", Math.round((Math.random() * 2 - 1) * 95) + "px");
        p.style.setProperty("--dy", Math.round(30 + Math.random() * 120) + "px");
        p.style.animationDelay = (Math.random() * 0.08).toFixed(2) + "s";
        layer.appendChild(p);
      }
    }
    setTimeout(() => layer.remove(), 1300);
  } catch (e) { /* décoratif : jamais bloquant */ }
}

/** Mode présentation : affichage plein écran pour montrer le projet (événements,
    réunions villageoises). N'affiche un compteur QUE s'il y a une donnée réelle
    (jamais de chiffre inventé). */
function openPresent() {
  const el = $("#present"); if (!el) return;
  const stat = $("#present-stat");
  if (stat) {
    const n = Array.isArray(_exploreEntries) ? _exploreEntries.length : 0;
    stat.textContent = n > 0 ? `${n} contribution${n > 1 ? "s" : ""} déjà rassemblée${n > 1 ? "s" : ""}` : "";
  }
  el.hidden = false;
  try { if (el.requestFullscreen) el.requestFullscreen(); } catch (e) { /* le plein écran peut être refusé : l'overlay suffit */ }
}
function closePresent() {
  const el = $("#present"); if (el) el.hidden = true;
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ok */ }
}

// --- Téléchargement du MODE PRÉSENTATION en image / PDF --------------------
// Affiche exactement l'affiche (logo, titre, 3 activités, QR agrandi) sur un
// <canvas> haute résolution — SANS aucune dépendance externe (CSP stricte). Le PNG
// vient de canvas.toBlob ; le PDF est un fichier minimal fait main qui embarque
// l'affiche en JPEG (filtre DCTDecode, universellement lu par les lecteurs PDF).
const PRESENT_URL = "https://langial.com/";

// Barres de partage du site (réseaux) disséminées : accueil, À propos, footer, présentation.
function mountShareBars() {
  // Paramètre ajouté au lien PARTAGÉ : certains réseaux (WhatsApp, Telegram) gardent
  // en cache le tout premier aperçu vu d'une URL. Si le lien nu a été partagé avant que
  // l'image d'aperçu existe, ils affichent « sans image » pour toujours. En partageant
  // une URL légèrement distincte (…?s=1), le réseau la voit comme neuve et récupère
  // l'aperçu à jour (avec l'image). Sans effet pour l'utilisateur : même application.
  const shareUrl = PRESENT_URL + "?s=1";
  const lang = getUiLang();
  const opts = {
    url: shareUrl,
    title: "LANGIAL",
    toast: toast,
    messageFor: (net) => shareMessage("home", net, {}, lang),   // texte marketing d'accueil, propre à chaque réseau
    emailSubject: shareSubject("home", lang),
    nativeLabel: t("share.native"),
    copyLabel: t("share.copy"),
    copiedMsg: t("share.copied"),
    copyCaptionMsg: t("share.caption.copied"),
    shareOnLabel: t("share.on"),
  };
  ["share-hub", "share-about", "share-foot", "share-present"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) mountShareBar(el, opts);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
/** #RRGGBB → rgba(r,g,b,a) pour caler les halos sur l'intensité des box-shadow CSS. */
function hexToRgba(hex, a) {
  let h = (hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (isNaN(n) || h.length !== 6) return "rgba(34,211,238," + a + ")";
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
/** Dessine l'affiche du mode présentation sur un canvas HD, calée sur le rendu affiché
    (thème clair/sombre, trame Ndop, halos doux, icônes premium). */
async function presentPosterCanvas() {
  const W = 1760, H = 2560;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const cs = getComputedStyle(document.documentElement);
  const V = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const bgc = V("--bg", "#0a0e14"), panel = V("--panel", "#12181f");
  const text = V("--text", "#e9f0f6"), muted = V("--muted", "#8b97a6");
  const cyan = V("--cyan", "#22d3ee"), green = V("--green", "#34d399"), gold = V("--gold", "#e5c07b");
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  g.fillStyle = bgc; g.fillRect(0, 0, W, H);
  // MÊME FOND QUE LE SITE : on pose l'IMAGE de motif Ndop (bg-pattern, clair/sombre) en
  // tuiles, à l'opacité du site, sur le voile de la couleur de fond (texte lisible). Repli
  // sur le motif vectoriel losange si l'image ne se charge pas (export toujours abouti).
  let patternDrawn = false;
  try {
    const pat = await loadImage(dark ? "./icons/bg-pattern-dark.jpg" : "./icons/bg-pattern-light.jpg");
    const TS = 460, th = TS * ((pat.height / pat.width) || 1);   // tuile (densité proche du site)
    g.save(); g.globalAlpha = dark ? 0.42 : 0.20;
    for (let ty = 0; ty < H; ty += th) for (let tx = 0; tx < W; tx += TS) g.drawImage(pat, tx, ty, TS, th);
    g.restore(); g.globalAlpha = 1;
    patternDrawn = true;
  } catch (e) { /* repli vectoriel ci-dessous */ }
  if (!patternDrawn) {
    const diamond = (cx, cy, r) => { g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); };
    g.save();
    for (let ty = 0; ty < H + 132; ty += 132) for (let tx = 0; tx < W + 132; tx += 132) {
      const cx = tx + 66, cy = ty + 66;
      g.lineWidth = 1.4; g.globalAlpha = dark ? 0.22 : 0.30; g.strokeStyle = gold; diamond(cx, cy, 62); g.stroke();
      g.lineWidth = 1.2; g.globalAlpha = dark ? 0.19 : 0.26; g.strokeStyle = cyan; diamond(cx, cy, 34); g.stroke();
      g.lineWidth = 0.9; g.globalAlpha = dark ? 0.14 : 0.20; g.strokeStyle = gold; diamond(cx, cy, 16); g.stroke();
    }
    g.restore(); g.globalAlpha = 1;
  }
  // Effet « TORCHE » : deux halos radiaux doux (comme l'aurore de l'app) qui donnent
  // l'impression qu'une lumière éclaire le fond. Composite « lighter » → la lumière
  // s'ADDITIONNE au décor (le motif Ndop s'illumine sous la torche).
  g.save(); g.globalCompositeOperation = "lighter";
  const torch = (cx, cy, r, hex, a) => {
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, hexToRgba(hex, a));
    rg.addColorStop(0.62, hexToRgba(hex, 0));
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  };
  torch(W * 0.14, H * 0.09, W * 0.95, cyan, dark ? 0.30 : 0.18);   // torche cyan, haut-gauche
  torch(W * 0.88, H * 0.93, W * 0.95, green, dark ? 0.24 : 0.15);  // torche verte, bas-droite
  torch(W * 0.5, H * 0.06, W * 0.70, gold, dark ? 0.16 : 0.11);    // reflet doré, au-dessus du logo
  g.restore(); g.globalAlpha = 1;
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  const rr = (x, y, w, h, r) => { if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); } else { g.beginPath(); g.rect(x, y, w, h); } };

  try {
    const logo = await loadImage("./icons/logo.svg");
    g.save(); g.shadowColor = hexToRgba(cyan, dark ? 0.8 : 0.58); g.shadowBlur = dark ? 76 : 56;
    g.drawImage(logo, W / 2 - 160, 140, 320, 320);
    // 2e passe : renforce encore le halo (deux couches → lumière plus dense)
    g.shadowBlur = dark ? 40 : 30; g.drawImage(logo, W / 2 - 160, 140, 320, 320); g.restore();
  } catch (e) { /* sans logo */ }
  const tg = g.createLinearGradient(W / 2 - 320, 0, W / 2 + 320, 0);
  tg.addColorStop(0, cyan); tg.addColorStop(1, green);
  g.fillStyle = tg; g.font = "800 176px system-ui, 'Segoe UI', sans-serif";
  g.fillText("LANGIAL", W / 2, 700);
  g.fillStyle = muted; g.font = "400 48px system-ui, 'Segoe UI', sans-serif";
  g.fillText("Numériser les langues d'Afrique, texte et voix", W / 2, 810);

  // Trois cartes ESPACÉES sur toute la largeur, PLUS GRANDES pour de plus grandes icônes.
  const acts = [["act-translate.svg", "Traduire", "mots et phrases"], ["mic-real.png", "Transcrire", "ta voix, ta langue"], ["act-explore.svg", "Explorer", "la bibliothèque commune"]];
  const actImgs = await Promise.all(acts.map((a) => loadImage("./icons/" + a[0]).catch(() => null)));
  const marginX = 100, cw = 440, ch = 330, y0 = 940;
  const gap = (W - 2 * marginX - acts.length * cw) / (acts.length - 1);
  // Une COULEUR de lumière propre à chaque carte (assortie à son icône) :
  // Traduire → vert, Transcrire → violet, Explorer → or.
  const cardGlow = [green, "#a78bfa", gold];
  let x = marginX;
  acts.forEach(([, lab, sub], i) => {
    const gc = cardGlow[i];
    // halo coloré autour de la carte (double passe → lumière plus dense)
    g.save(); g.shadowColor = hexToRgba(gc, dark ? 0.72 : 0.52); g.shadowBlur = dark ? 54 : 40;
    g.fillStyle = panel; rr(x, y0, cw, ch, 28); g.fill();
    g.shadowBlur = dark ? 30 : 22; rr(x, y0, cw, ch, 28); g.fill(); g.restore();
    g.globalAlpha = dark ? 0.12 : 0.10; g.fillStyle = gc; rr(x, y0, cw, ch, 28); g.fill(); g.globalAlpha = 1; // voile coloré interne
    g.globalAlpha = 0.85; g.strokeStyle = gc; g.lineWidth = 6; rr(x, y0, cw, ch, 28); g.stroke(); g.globalAlpha = 1;
    if (actImgs[i]) g.drawImage(actImgs[i], x + cw / 2 - 82, y0 + 42, 164, 164);
    g.textAlign = "center";
    g.font = "700 44px system-ui, sans-serif"; g.fillStyle = text; g.fillText(lab, x + cw / 2, y0 + 258);
    g.font = "400 28px system-ui, sans-serif"; g.fillStyle = muted; g.fillText(sub, x + cw / 2, y0 + 300);
    x += cw + gap;
  });

  const pX = 110, pY = 1420, pW = W - 220, pH = 1000;
  g.save(); g.shadowColor = hexToRgba(cyan, dark ? 0.5 : 0.32); g.shadowBlur = dark ? 72 : 48;
  g.fillStyle = panel; rr(pX, pY, pW, pH, 30); g.fill(); g.restore();
  g.globalAlpha = 0.07; g.fillStyle = cyan; rr(pX, pY, pW, pH, 30); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = cyan; g.globalAlpha = 0.55; g.lineWidth = 3; rr(pX, pY, pW, pH, 30); g.stroke(); g.globalAlpha = 1;

  g.fillStyle = cyan; g.font = "800 66px system-ui, sans-serif"; g.textAlign = "center";
  g.fillText("Scanne pour contribuer", W / 2, pY + 112);

  const qz = 560;
  try {
    const qr = await loadImage("./flyer/qr.png");
    g.save(); g.shadowColor = hexToRgba(cyan, dark ? 0.85 : 0.55); g.shadowBlur = dark ? 88 : 64;
    g.drawImage(qr, W / 2 - qz / 2, pY + 170, qz, qz);
    // 2e passe : halo plus dense au ras du cadre
    g.shadowBlur = dark ? 46 : 34; g.drawImage(qr, W / 2 - qz / 2, pY + 170, qz, qz); g.restore();
  } catch (e) { /* sans QR */ }

  const urlTxt = PRESENT_URL.replace(/^https:\/\//, "");
  const padX = 44, maxPillW = pW - 80;
  let fs = 44;
  g.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
  let tw = g.measureText(urlTxt).width;
  if (tw + 2 * padX > maxPillW) {
    fs = Math.floor(fs * (maxPillW - 2 * padX) / tw);
    g.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    tw = g.measureText(urlTxt).width;
  }
  const pillW = tw + 2 * padX, pillH = 96, pillX = W / 2 - pillW / 2, pillY = pY + 812;
  g.fillStyle = muted; g.font = "400 32px system-ui, sans-serif"; g.textAlign = "center";
  g.fillText("Ou ouvre l'adresse :", W / 2, pillY - 26);
  // pastille MISE EN ÉVIDENCE : fond doré plus dense + halo doré + bordure épaisse
  g.save(); g.shadowColor = hexToRgba(gold, dark ? 0.6 : 0.42); g.shadowBlur = dark ? 40 : 28;
  g.globalAlpha = dark ? 0.22 : 0.20; g.fillStyle = gold; rr(pillX, pillY, pillW, pillH, 16); g.fill();
  g.globalAlpha = 1; g.restore();
  g.strokeStyle = gold; g.lineWidth = 4; rr(pillX, pillY, pillW, pillH, 16); g.stroke();
  g.fillStyle = gold; g.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
  g.textBaseline = "middle"; g.fillText(urlTxt, W / 2, pillY + pillH / 2 + 2); g.textBaseline = "alphabetic";
  const stat = ($("#present-stat") && $("#present-stat").textContent.trim()) || "";
  if (stat) { g.fillStyle = muted; g.font = "400 33px system-ui, sans-serif"; g.fillText(stat, W / 2, pillY + pillH + 60); }
  g.shadowColor = "transparent"; g.shadowBlur = 0;
  return cv;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
/** Construit un PDF minimal (1 page) embarquant le canvas en JPEG (DCTDecode). */
function canvasToPdfBlob(canvas) {
  const W = canvas.width, H = canvas.height;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
  const bin = atob(dataUrl.split(",")[1]);
  const jpg = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpg[i] = bin.charCodeAt(i);
  const enc = (s) => new TextEncoder().encode(s);
  const parts = []; const off = []; let pos = 0;
  const push = (u8) => { parts.push(u8); pos += u8.length; };
  const obj = (n, body) => { off[n] = pos; push(enc(`${n} 0 obj\n${body}\nendobj\n`)); };
  push(enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  const content = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`;
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  off[5] = pos;
  push(enc(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`));
  push(jpg);
  push(enc("\nendstream\nendobj\n"));
  const xrefPos = pos;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += String(off[i]).padStart(10, "0") + " 00000 n \n";
  push(enc(xref));
  push(enc(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return new Blob([out], { type: "application/pdf" });
}
async function downloadPresent(kind) {
  // Affiche DESSINÉE : image propre (aucun bouton, aucun curseur, aucune autorisation).
  let cv = null;
  try { cv = await presentPosterCanvas(); }
  catch (e) { toast(t("toast.dl.na"), "warn"); return; }
  try {
    if (kind === "pdf") {
      downloadBlob(canvasToPdfBlob(cv), "langa-presentation.pdf");
    } else {
      await new Promise((res) => cv.toBlob((b) => { downloadBlob(b, "langa-presentation.png"); res(); }, "image/png"));
    }
    toast(t("toast.present.dl"), "ok");
  } catch (e) {
    toast(t("toast.dl.na"), "warn");
  }
}
function setStatus(msg) {
  $("#send-status").textContent = msg || "";
}

// --- Détection de nouvelle version + mise à jour en 1 clic -----------------
// Corrige le « ça ne prend qu'après Ctrl+Shift+R » : on compare la version
// DÉPLOYÉE (lue dans sw.js, toujours re-téléchargé sans cache) à la version qui
// TOURNE (APP_VERSION). Si le déployé est plus récent → bannière voyante. Le
// bouton vide les caches + active le nouveau SW + recharge (= Ctrl+Shift+R auto).
const _verNum = (v) => parseInt(String(v || "").replace(/\D/g, ""), 10) || 0;
async function fetchDeployedVersion() {
  try {
    const r = await fetch("./sw.js?ts=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return null;
    const m = (await r.text()).match(/collecte-nge-(v\d+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
/** Améliorations des SEULES versions que l'utilisateur a manquées, REGROUPÉES par
    version : toutes les versions du changelog strictement > sa version courante et
    <= la version déployée. Ainsi, en passant par exemple de v100 à v105, la bannière
    liste les nouveautés de CHAQUE version intermédiaire (v101, v102 … v105), pas
    seulement la dernière ; et jamais celles des versions déjà installées.
    Renvoie un tableau [{ version, notes[] }] trié de la plus récente à la plus ancienne. */
async function relevantNotes(dep) {
  try {
    const r = await fetch("./version.json?ts=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    const cl = data.changelog || {};
    const run = _verNum(APP_VERSION), to = _verNum(dep);
    const versions = Object.keys(cl)
      .filter((v) => { const n = _verNum(v); return n > run && n <= to; })
      .sort((a, b) => _verNum(b) - _verNum(a));   // la plus récente d'abord
    let groups = versions
      .map((v) => ({ version: v, notes: (cl[v] || []).filter(Boolean) }))
      .filter((g) => g.notes.length);
    if (!groups.length && cl[dep]) groups = [{ version: dep, notes: (cl[dep] || []).filter(Boolean) }];       // repli : notes de la version déployée
    if (!groups.length && Array.isArray(data.notes)) groups = [{ version: dep, notes: data.notes.filter(Boolean) }]; // repli : ancien format plat
    return groups;
  } catch (e) { return null; }
}
/** Peint la liste des nouveautés dans la bannière. Une seule version manquée → simple
    liste à puces. Plusieurs → un bloc par version, chacun coiffé de son étiquette, et
    un récapitulatif dynamique (« en retard de N versions »). */
function renderUpdateNotes(groups, dep) {
  const box = $("#update-notes"); if (!box) return;
  const list = (groups && groups.length) ? groups : [{ version: dep, notes: [t("update.fallback.note")] }];
  const sub = $("#update-sub");
  if (sub) {
    sub.textContent = list.length > 1
      ? ti("update.sub.multi", { n: list.length })
      : t("update.sub.one");
  }
  box.innerHTML = "";
  const multi = list.length > 1;
  list.forEach((g) => {
    const grp = document.createElement("div");
    grp.className = "update-vgrp";
    if (multi) {
      const tag = document.createElement("div");
      tag.className = "update-vtag";
      tag.textContent = ti("update.vtag", { v: g.version });
      grp.appendChild(tag);
    }
    const ul = document.createElement("ul");
    ul.className = "update-notes-list";
    g.notes.forEach((n) => { const li = document.createElement("li"); li.textContent = n; ul.appendChild(li); });
    grp.appendChild(ul);
    box.appendChild(grp);
  });
}
let _updateShown = false;
let _deployedVer = "";   // dernière version déployée détectée (cible d'une mise à jour)
const _hideBanner = () => {
  const bn = $("#update-banner"); if (bn) bn.hidden = true; _updateShown = false;
};
/** Vérifie s'il existe une version déployée plus récente et pilote la bannière.
    ROBUSTESSE : cette fonction est la GARDE UNIQUE de la visibilité de la bannière.
    - App à jour (déployé <= courant) → la bannière est TOUJOURS masquée (auto-guérison :
      même une bannière restée ouverte se referme d'elle-même). C'est le filet qui
      garantit qu'après une mise à jour réussie, elle disparaît pour de bon.
    - Version écartée via « Plus tard » → on ne ré-affiche pas pour CETTE version
      (mémoire locale), mais une version encore plus récente rouvre la bannière. */
function _setVerBadge(behind) {
  const av = $("#app-ver"); if (av) av.className = "chip " + (behind ? "chip--off" : "chip--on");
}
async function checkForUpdate() {
  const dep = await fetchDeployedVersion();
  if (!dep || _verNum(dep) <= _verNum(APP_VERSION)) {   // rien de plus récent → à jour
    _setVerBadge(false);                                 // pastille version VERTE (à jour)
    _hideBanner();
    localStorage.removeItem("updateDismissed");          // repart propre pour la prochaine fois
    return;
  }
  _setVerBadge(true);   // une version plus récente existe → pastille version ROUGE
  _deployedVer = dep;   // cible mémorisée (sert au vérificateur d'après-mise-à-jour)
  const banner = $("#update-banner"); if (!banner) return;
  if (localStorage.getItem("updateDismissed") === dep) { banner.hidden = true; return; } // écartée pour cette version
  const vEl = $("#update-ver"); if (vEl) vEl.textContent = dep;
  if (!_updateShown) {
    _updateShown = true;
    renderUpdateNotes(await relevantNotes(dep), dep);
  }
  banner.hidden = false;
}
// Cœur partagé (bouton « Mettre à jour » ET vérificateur d'après-coup) : purge les
// caches, active le nouveau SW, puis recharge UNE fois quand il a pris le contrôle
// (controllerchange), avec un filet de sécurité temporisé. Combiné au SW qui récupère
// la coquille en { cache: "reload" }, le rechargement obtient à coup sûr les fichiers
// frais — plus besoin de Ctrl+Shift+R. Event-driven : on « ping » le nouveau worker
// dès qu'il est installé (waiting OU installing→installed OU updatefound), sans
// dépendre d'un instant précis.
async function applyUpdate() {
  const btn = $("#update-now"); if (btn) { btn.disabled = true; btn.textContent = t("update.wip"); }
  showAppLoader();   // voile pendant la manœuvre de mise à jour + rechargement
  localStorage.removeItem("updateDismissed");   // on met vraiment à jour → oublie tout report
  let _reloaded = false;
  const hardReload = () => { if (_reloaded) return; _reloaded = true; location.reload(); };
  try {
    // 1) purge d'abord les caches du SW (sinon l'ancien app.js pourrait resurgir)
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); }
    // 2) active le nouveau SW ; on rechargera à controllerchange
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", hardReload, { once: true });
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        const ping = (w) => { if (w && w.state !== "redundant") w.postMessage({ type: "SKIP_WAITING" }); };
        const watch = (w) => {
          if (!w) return;
          if (w.state === "installed") ping(w);
          w.addEventListener("statechange", () => { if (w.state === "installed") ping(w); });
        };
        reg.addEventListener("updatefound", () => watch(reg.installing));
        if (reg.waiting) ping(reg.waiting);
        watch(reg.installing);
        try { await reg.update(); } catch (e) { /* ok */ }
        watch(reg.installing);
      }
    }
  } catch (e) { /* on recharge quand même via le filet ci-dessous */ }
  setTimeout(hardReload, 2500);   // filet : si pas de controllerchange (SW déjà actif…), on recharge quand même
}
let _updating = false;
async function doUpdate() {
  if (_updating) return; _updating = true;
  // Mémorise la CIBLE : au prochain démarrage, verifyUpdateApplied() confirmera que
  // l'app est bien passée à cette version — sinon il relancera la manœuvre (borné).
  try {
    const prev = JSON.parse(sessionStorage.getItem("pendingUpdate") || "null");
    const tries = (prev && prev.to === _deployedVer) ? (prev.tries || 0) : 0;
    sessionStorage.setItem("pendingUpdate", JSON.stringify({ to: _deployedVer || "", tries }));
  } catch (e) { /* sessionStorage indispo : on met à jour quand même */ }
  await applyUpdate();
}
/** Verdict PUR (testable) du vérificateur d'après-mise-à-jour, d'après l'objectif
    mémorisé `pend` = {to, tries} et la version qui tourne `running`.
    "none" = rien à vérifier · "done" = l'app a bien atteint la cible ·
    "retry" = pas encore, on relance (borné) · "giveup" = trop d'essais, on abandonne. */
function updateVerdict(pend, running) {
  if (!pend || !pend.to) return "none";
  if (_verNum(running) >= _verNum(pend.to)) return "done";
  if ((pend.tries || 0) >= 2) return "giveup";
  return "retry";
}
/** Filet ultime : après un clic « Mettre à jour » + rechargement, on vérifie que la
    mise à jour a VRAIMENT pris. Si non (SW lent, controllerchange manqué…), on relance
    automatiquement — 2 fois au plus — puis on affiche un message honnête au lieu de
    boucler en silence. Appelé une fois au démarrage. */
async function verifyUpdateApplied() {
  let pend = null;
  try { pend = JSON.parse(sessionStorage.getItem("pendingUpdate") || "null"); } catch (e) { pend = null; }
  const verdict = updateVerdict(pend, APP_VERSION);
  if (verdict === "none") return;
  if (verdict === "done") {
    sessionStorage.removeItem("pendingUpdate");
    toast(ti("toast.upd.uptodate", { v: APP_VERSION }));
    return;
  }
  if (verdict === "giveup") {
    sessionStorage.removeItem("pendingUpdate");
    toast(t("toast.upd.manual"), "warn");
    return;
  }
  // "retry" : nouvelle tentative bornée
  sessionStorage.setItem("pendingUpdate", JSON.stringify({ to: pend.to, tries: (pend.tries || 0) + 1 }));
  _deployedVer = pend.to;
  toast(t("toast.upd.finalizing"));
  await applyUpdate();
}

// --- Initialisation ------------------------------------------------------
function initKeyboard() {
  // Clavier piloté par l'alphabet de la LANGUE COURANTE (dédié) ; null → repli ngiemboon
  // (masqué de toute façon pour une langue à clavier système).
  keyboard = new NgiemboonKeyboard($("#kb-host"), ngeField(), langAlphabet(getCurrentLangId()));
  // Zone d'aide phonétique au-dessus du clavier (affichée à la frappe).
  keyboard.setPanel($("#tip-panel"));
  const toggle = $("#tips-toggle");
  if (toggle) {
    // Activée par défaut : elle s'affiche désormais dans la zone dédiée (utile
    // aussi sur mobile), plus au survol. Le toggle permet de la masquer.
    keyboard.setTips(toggle.checked);
    toggle.addEventListener("change", (e) => keyboard.setTips(e.target.checked));
  }
  initPredict();
}

// --- Clavier prédictif : barre de suggestions de MOTS RÉELS -------------------
// Moteur GÉNÉRIQUE (predict.js) amorcé par le LEXIQUE DU PACK de la langue courante
// (langpacks.js) et qui APPREND en plus des contributions déjà collectées. La barre
// apparaît pour toute langue à CLAVIER DÉDIÉ, et seulement s'il y a à proposer.
function initPredict() {
  if (!predict) predict = new Predict(langLexicon(getCurrentLangId()));
  const strip = $("#kb-suggest");
  if (!strip) return;
  // Un seul écouteur délégué : quand le champ ciblé par le clavier change (frappe,
  // déplacement du curseur), on rafraîchit les suggestions.
  const onFieldActivity = (e) => {
    if (keyboard && e.target === keyboard.target) predictUpdate();
  };
  document.addEventListener("input", onFieldActivity, true);
  document.addEventListener("keyup", onFieldActivity, true);
  document.addEventListener("click", onFieldActivity, true);
  // Clic sur une suggestion → insertion (délégation, robuste au re-render).
  strip.addEventListener("pointerdown", (e) => {
    const chip = e.target.closest(".kb-sugg");
    if (!chip) return;
    e.preventDefault();               // ne pas voler le focus au champ
    predictAccept(chip.dataset.w || "");
  });
}

/** Le clavier prédictif est-il pertinent ? Oui pour toute langue à CLAVIER DÉDIÉ
    (le moteur propose depuis le lexique du pack + les contributions apprises). */
function predictActive() {
  return !!predict && usesDedicatedKeyboard(getCurrentLangId()) && !!(keyboard && keyboard.target);
}

function predictHide() {
  const strip = $("#kb-suggest");
  if (strip && !strip.hidden) { strip.hidden = true; strip.textContent = ""; }
}

/** Recalcule et affiche les suggestions pour le mot en cours de frappe. */
function predictUpdate() {
  const strip = $("#kb-suggest");
  if (!strip) return;
  if (!predictActive()) return predictHide();
  const el = keyboard.target;
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const m = before.match(PRED_BEFORE);
  const prefix = m ? m[0] : "";
  if (!prefix) return predictHide();
  const sugg = predict.complete(prefix, 3);
  if (!sugg.length) return predictHide();
  // Rendu SÛR : mots issus du lexique ET des contributions (texte utilisateur) →
  // jamais d'innerHTML, uniquement du textContent.
  strip.textContent = "";
  for (const s of sugg) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-sugg";
    b.dataset.w = s.m;
    const w = document.createElement("span");
    w.className = "kb-sugg-w"; w.textContent = s.m;
    b.appendChild(w);
    if (s.fr) {
      const fr = document.createElement("span");
      fr.className = "kb-sugg-fr"; fr.textContent = s.fr;
      b.appendChild(fr);
    }
    strip.appendChild(b);
  }
  strip.hidden = false;
}

/** Remplace le mot en cours par la suggestion choisie (+ espace) et refocalise. */
function predictAccept(word) {
  word = (word || "").normalize("NFC");
  if (!word || !predictActive()) return;
  const el = keyboard.target;
  const val = el.value;
  const caret = el.selectionStart ?? val.length;
  const before = val.slice(0, caret);
  const after = val.slice(caret);
  const bm = before.match(PRED_BEFORE);
  const am = after.match(PRED_AFTER);
  const start = caret - (bm ? bm[0].length : 0);
  const end = caret + (am ? am[0].length : 0);
  const head = val.slice(0, start) + word + " ";
  el.value = (head + val.slice(end)).normalize("NFC");
  el.selectionStart = el.selectionEnd = head.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  predictHide();
}

// --- Clavier au FOCUS (façon WhatsApp) : masqué par défaut, ouvert au tap du
//     champ ngiemboon, fermé en touchant ailleurs. Évite les insertions au scroll
//     (le clavier n'est plus sous le doigt quand on fait défiler la page). --------
let _kbField = null;
/** Ouverture VISUELLE : panneau détaché vers <body> (portail → premier plan),
    ancré en bas ; le champ remonte juste au-dessus. */
function _kbDockOpen() {
  const b = $("#kb-block"); if (!b) return;
  b.classList.add("is-open");
  const panel = $("#kb-panel");
  if (panel && panel.parentNode !== document.body) {
    panel._origParent = panel.parentNode;
    document.body.appendChild(panel);
  }
  if (panel) panel.classList.add("kb-floating");
  document.body.classList.add("kb-docked");
  const h = panel ? panel.offsetHeight : Math.round(window.innerHeight * 0.45);
  document.body.style.setProperty("--kb-h", h + "px");
  if (_kbField) {
    const kbTop = window.innerHeight - h;
    const r = _kbField.getBoundingClientRect();
    if (r.bottom > kbTop - 10) window.scrollBy({ top: r.bottom - (kbTop - 10), behavior: "smooth" });
  }
}
/** Fermeture VISUELLE : remet le panneau dans son bloc, libère la place. */
function _kbDockClose() {
  const b = $("#kb-block"); if (b) b.classList.remove("is-open");
  const panel = $("#kb-panel");
  if (panel) {
    panel.classList.remove("kb-floating");
    if (panel._origParent) { panel._origParent.appendChild(panel); panel._origParent = null; }
  }
  document.body.classList.remove("kb-docked");
}
function showKeyboard() {
  if (isKbOpen()) return;
  _kbDockOpen();
  predictUpdate();
  // Le bouton RETOUR du téléphone ferme le clavier (comme WhatsApp) au lieu de quitter
  // la page : c'est le ROUTEUR (onHistoryNav) qui l'intercepte — le clavier ne touche
  // plus lui-même à l'historique (sinon course avec le pushState des vues).
}
function hideKeyboard() {
  if (!isKbOpen()) return;
  _kbDockClose();
  predictHide();
}
function isKbOpen() { const b = $("#kb-block"); return !!(b && b.classList.contains("is-open")); }
/** (Re)lie l'ouverture au champ ngiemboon COURANT (change selon le sens). On lie
    au pointerdown (vrai tap utilisateur), pas au focus programmatique. */
/** Ouverture INTELLIGENTE : sur tactile, on n'ouvre le clavier que pour un VRAI
    tap (contact bref et immobile). Un défilement qui commence sur le champ bouge
    le doigt → on n'ouvre pas (corrige l'ouverture intempestive au scroll). À la
    souris, un clic ne défile jamais → ouverture directe. Le bouton « Ouvrir le
    clavier » reste toujours disponible comme voie explicite. */
function onFieldPointerDown(e) {
  if (e.pointerType && e.pointerType !== "touch" && e.pointerType !== "pen") { showKeyboard(); return; }
  const x0 = e.clientX, y0 = e.clientY, t0 = Date.now();
  let moved = false;
  const MOVE_MAX = 10, TAP_MS = 500;
  function mv(ev) { if (Math.abs(ev.clientX - x0) > MOVE_MAX || Math.abs(ev.clientY - y0) > MOVE_MAX) moved = true; }
  function cleanup() {
    document.removeEventListener("pointermove", mv);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cleanup);
  }
  function up() { cleanup(); if (!moved && Date.now() - t0 <= TAP_MS) showKeyboard(); }
  document.addEventListener("pointermove", mv, { passive: true });
  document.addEventListener("pointerup", up, { once: true });
  document.addEventListener("pointercancel", cleanup, { once: true });
}
function bindKeyboardReveal() {
  const field = ngeField();
  if (_kbField === field) return;
  if (_kbField) _kbField.removeEventListener("pointerdown", onFieldPointerDown);
  _kbField = field;
  if (_kbField) _kbField.addEventListener("pointerdown", onFieldPointerDown);
}
/** Détection de vrai tap générique (réutilisée hors du champ principal, ex. le
    champ « proposer une traduction » d'Explorer) : ouvre openFn sur tap immobile
    (tactile) ou clic (souris), jamais sur un défilement. */
function attachKbTap(field, openFn) {
  field.addEventListener("pointerdown", (e) => {
    if (e.pointerType && e.pointerType !== "touch" && e.pointerType !== "pen") { openFn(); return; }
    const x0 = e.clientX, y0 = e.clientY, t0 = Date.now();
    let moved = false;
    function mv(ev) { if (Math.abs(ev.clientX - x0) > 10 || Math.abs(ev.clientY - y0) > 10) moved = true; }
    function cleanup() {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cleanup);
    }
    function up() { cleanup(); if (!moved && Date.now() - t0 <= 500) openFn(); }
    document.addEventListener("pointermove", mv, { passive: true });
    document.addEventListener("pointerup", up, { once: true });
    document.addEventListener("pointercancel", cleanup, { once: true });
  });
}
/** Ouvre le clavier ngiemboon en le RECIBLANT sur un champ arbitraire (le même
    clavier unique sert le champ de travail ET les champs d'Explorer). */
function openKeyboardFor(field) {
  if (!field || !keyboard) return;
  _kbField = field;
  keyboard.setTarget(field);          // insère désormais dans ce champ (+ supprime le clavier OS)
  showKeyboard();
}
function initKeyboardReveal() {
  const openBtn = $("#kb-open-btn");
  if (openBtn) openBtn.addEventListener("click", () => {
    showKeyboard();
    if (_kbField) { try { _kbField.focus({ preventScroll: true }); } catch (e) { _kbField.focus(); } }
  });
  const closeBtn = $("#kb-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", hideKeyboard);
  // Fermer si on touche AILLEURS que le clavier ou le champ ngiemboon.
  document.addEventListener("pointerdown", (e) => {
    if (!isKbOpen()) return;
    const block = $("#kb-block"), panel = $("#kb-panel");
    if (block && block.contains(e.target)) return;
    if (panel && panel.contains(e.target)) return;   // clic sur le clavier (portalé dans body)
    if (_kbField && (e.target === _kbField || _kbField.contains(e.target))) return;
    hideKeyboard();
  });
  // (Le bouton RETOUR qui ferme le clavier est géré par le routeur — onHistoryNav.)
  bindKeyboardReveal();
}

function setupVillageCombo() {
  const combo = $("#village-combo");
  const input = $("#c-village");
  const toggle = $("#village-toggle");
  const list = $("#village-list");
  const flo = floatList(combo, list);   // même liste flottante au premier plan
  const render = (filter) => {
    // Villages/variantes de la LANGUE COURANTE (ngiemboon a sa liste ; une langue
    // déclarée n'en a pas encore → seule « Autre » s'affiche, saisie 100 % libre).
    const villages = currentLang().villages || [];
    const q = (filter || "").trim().toLowerCase();
    const matches = villages.filter((v) => v.toLowerCase().includes(q));
    // « Autre » en PREMIÈRE position, puis la liste des villages.
    list.innerHTML =
      `<li class="combo-autre" data-autre="1">✎ Autre, saisir mon propre village</li>` +
      matches.map((v) => `<li data-v="${escapeHtml(v)}">${escapeHtml(v)}</li>`).join("");
    list.querySelectorAll("li").forEach((li) =>
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (li.dataset.autre) { input.value = ""; input.focus(); }
        else { input.value = li.dataset.v; }
        flo.close();
        collectContributeur();
      })
    );
    if (!list.hidden) flo.reposition();   // la hauteur a pu changer (filtrage)
  };
  const open = (filter) => { render(filter || ""); flo.open(); };
  toggle.addEventListener("click", () => (list.hidden ? open("") : flo.close()));
  input.addEventListener("focus", () => open(""));
  input.addEventListener("input", () => open(input.value));
  document.addEventListener("click", (e) => {
    if (!combo.contains(e.target) && !list.contains(e.target)) flo.close();
  });
}
// --- Menus déroulants personnalisés (affichage cohérent sur mobile) ----------
// Un <select> natif ouvre le sélecteur de l'OS (détaché, non stylé). enhanceSelect
// l'habille d'un menu identique au combo Village : liste attachée au champ, même
// style. Le <select> reste la SOURCE de vérité (masqué) → toute la logique
// (validation, persistance, écouteurs 'change') est inchangée.
const _enhancedSyncers = [];
function refreshEnhancedSelects() { _enhancedSyncers.forEach((fn) => fn()); }

/** Rend une liste déroulante FLOTTANTE : position fixed + PREMIER PLAN (z 1000),
    calée sous le champ, JAMAIS rognée par un conteneur ni cachée par un autre
    élément ; bascule au-dessus si pas la place. Utilisé par TOUS les menus
    (enhanceSelect + combo Village) → comportement uniforme partout. */
function floatList(combo, list) {
  const position = () => {
    const r = combo.getBoundingClientRect();
    list.style.position = "fixed";
    list.style.left = r.left + "px"; list.style.right = "auto";
    list.style.minWidth = r.width + "px"; list.style.width = "auto";
    list.style.zIndex = "2147483000";   // au-dessus de TOUT (aucun cadre ne l'occulte)
    const h = list.offsetHeight, below = r.bottom + 4;
    list.style.top = ((below + h <= window.innerHeight - 8) ? below : Math.max(8, r.top - 4 - h)) + "px";
  };
  const onReflow = () => { if (!list.hidden) position(); };
  return {
    open() {
      // On DÉPLACE la liste sous <body> : ainsi AUCUN ancêtre (transform, filter,
      // overflow, contexte d'empilement d'une carte) ne peut la rogner ni la
      // cacher. Elle flotte au premier plan absolu, ancrée sous le champ via
      // position(). Comportement identique PC / mobile, quel que soit le support.
      if (list.parentNode !== document.body) {
        list._origParent = list.parentNode;
        list._origNext = list.nextSibling;
        document.body.appendChild(list);
      }
      list.hidden = false; position();
      window.addEventListener("scroll", onReflow, true);
      window.addEventListener("resize", onReflow);
    },
    close() {
      if (list.hidden) return;
      list.hidden = true;
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      // On remet la liste à sa place d'origine (dans le combo) pour ne pas
      // laisser d'orphelins sous <body> et garder le DOM propre.
      if (list._origParent) {
        list._origParent.insertBefore(list, list._origNext || null);
        list._origParent = null; list._origNext = null;
      }
    },
    reposition() { onReflow(); },
  };
}
function enhanceSelect(sel) {
  if (!sel || sel.dataset.enhanced) return;
  sel.dataset.enhanced = "1";
  const combo = document.createElement("div");
  combo.className = ("combo combo--select " + (sel.className || "")).trim();
  const display = document.createElement("button");
  display.type = "button"; display.className = "combo-display";
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "combo-toggle";
  toggle.setAttribute("aria-label", t("combo.see")); toggle.textContent = "▾";
  const list = document.createElement("ul");
  list.className = "combo-list"; list.hidden = true;
  sel.parentNode.insertBefore(combo, sel);
  combo.append(display, toggle, list, sel);   // déplace le <select> DANS le combo
  sel.className = "sr-only"; sel.setAttribute("tabindex", "-1"); sel.setAttribute("aria-hidden", "true");

  const syncDisplay = () => {
    const o = sel.options[sel.selectedIndex] || null;
    display.textContent = (o && o.textContent) || "Choisir…";
    display.classList.toggle("is-placeholder", !o || o.value === "");
  };
  const f = floatList(combo, list);   // liste flottante au premier plan (uniforme)
  const render = () => {
    list.innerHTML = "";
    Array.from(sel.options).forEach((o) => {
      if (o.disabled) return;   // saute le placeholder désactivé « Choisir… »
      const li = document.createElement("li");
      li.textContent = o.textContent; li.dataset.val = o.value;
      if (o.value === sel.value) li.className = "is-sel";
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        sel.value = o.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));   // → collectContributeur
        syncDisplay();
        f.close();
      });
      list.appendChild(li);
    });
  };
  const open = () => { render(); f.open(); };
  const toggleList = () => (list.hidden ? open() : f.close());
  display.addEventListener("click", toggleList);
  toggle.addEventListener("click", toggleList);
  document.addEventListener("click", (e) => { if (!combo.contains(e.target) && !list.contains(e.target)) f.close(); });
  sel.addEventListener("change", syncDisplay);
  _enhancedSyncers.push(syncDisplay);
  syncDisplay();
}
/** Habille AUTOMATIQUEMENT tout <select> (existant ou ajouté dynamiquement) →
    plus besoin de configurer chaque menu à la main. */
function initSelectAutoEnhance() {
  document.querySelectorAll("select:not([data-enhanced])").forEach((s) => enhanceSelect(s));
  const obs = new MutationObserver((muts) => {
    muts.forEach((m) => m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      if (node.tagName === "SELECT" && !node.dataset.enhanced) enhanceSelect(node);
      else if (node.querySelectorAll) node.querySelectorAll("select:not([data-enhanced])").forEach((s) => enhanceSelect(s));
    }));
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
function initIndicatifs() {
  const sel = $("#c-indicatif");
  // Aucun indicatif par défaut : l'utilisateur choisit lui-même son pays.
  sel.innerHTML = `<option value="" disabled selected>${escapeHtml(t("p.indicatif.choose"))}</option>` +
    (CONFIG.INDICATIFS || []).map((x) =>
      `<option value="${escapeHtml(x.d)}">${x.f} ${escapeHtml(x.p)} (${escapeHtml(x.d)})</option>`
    ).join("");
}
// --- Infobulles par champ (ⓘ) : une aide COURTE et ciblée sur chaque champ du
// profil et de la déclaration de langue, en complément de la visite guidée (qui,
// elle, raconte le parcours). Le petit ⓘ se place en coin haut-droit du champ, HORS
// de l'élément traduit (data-i18n), pour survivre à la bascule FR/EN. Clic = popover.
const FIELD_TIPS = {
  "c-nom": { fr: "Ton nom de famille. Il sert à te créditer et à te recontacter si besoin. Il n'est jamais affiché publiquement : seul le crédit que tu choisis plus bas peut l'être.",
             en: "Your family name. Used to credit you and to reach you if needed. It is never shown publicly: only the credit you choose below may be." },
  "c-prenom": { fr: "Ton prénom. C'est lui qui peut apparaître comme crédit public sur tes contributions, si tu l'autorises plus bas.",
                en: "Your first name. It can appear as the public credit on your contributions, if you allow it below." },
  "c-village": { fr: "Le village ou quartier d'où vient ta façon de parler. Les mots changent d'un village à l'autre : cette information situe ta variante.",
                 en: "The village or neighbourhood your way of speaking comes from. Words change from one village to another: this places your variety." },
  "c-role": { fr: "Locuteur natif, apprenant ou linguiste. Cela indique aux autres le poids de ta contribution : un natif fait autorité sur la prononciation.",
              en: "Native speaker, learner or linguist. It tells others how much weight your contribution carries: a native is authoritative on pronunciation." },
  "c-email": { fr: "Pour te recontacter si une contribution demande une précision. Jamais affiché publiquement, jamais transmis à des tiers.",
               en: "To reach you if a contribution needs clarification. Never shown publicly, never shared with third parties." },
  "c-tel": { fr: "Ton numéro avec l'indicatif du pays. Sert uniquement à te joindre si besoin ; jamais public.",
             en: "Your number with the country code. Only used to reach you if needed; never public." },
  "c-consent": { fr: "Autorisation d'utiliser tes contributions pour documenter et outiller la langue, et de te contacter à ce sujet. Obligatoire pour participer.",
                 en: "Permission to use your contributions to document and equip the language, and to contact you about it. Required to take part." },
  "c-credit-on": { fr: "Si tu coches, ton prénom ou sigle apparaît sur tes contributions et dans les notifications envoyées aux autres. Sinon, tu restes anonyme.",
                   en: "If ticked, your first name or initials appear on your contributions and in notifications sent to others. Otherwise you stay anonymous." },
  "ld-nom": { fr: "Le nom courant de la langue en français (ex. Bassa, Douala).",
              en: "The common name of the language in French (e.g. Bassa, Douala)." },
  "ld-region": { fr: "La région d'ORIGINE de la langue (pas là où tu vis) : le berceau où elle est née, ex. l'Ouest pour le ngiemboon, même si tu es à Garoua.",
                 en: "The language's region of ORIGIN (not where you live): its cradle, e.g. the West for Ngiemboon even if you are in Garoua." },
  "ld-pays": { fr: "Le pays d'ORIGINE de la langue (celui de sa région d'origine), pas forcément ton pays de naissance ou de résidence.",
               en: "The language's country of ORIGIN (of its home region), not necessarily where you were born or live." },
  "ld-famille": { fr: "La famille ou le groupe linguistique (ex. bantou, bamiléké). Aide à relier les langues proches.",
                  en: "The language family or group (e.g. Bantu, Bamileke). Helps relate nearby languages." },
  "ld-autonyme": { fr: "Le nom de la langue DANS la langue elle-même, tel que ses locuteurs l'appellent.",
                   en: "The name of the language IN the language itself, as its speakers call it." },
  "ld-alias": { fr: "D'autres noms ou orthographes de la langue, séparés par des virgules. Évite les doublons quand deux personnes l'écrivent différemment.",
                en: "Other names or spellings of the language, comma-separated. Avoids duplicates when two people write it differently." },
  "ld-note": { fr: "Lettres, sons ou tons particuliers à prévoir, en vue d'un futur clavier dédié à la langue.",
               en: "Special letters, sounds or tones to plan for, towards a future dedicated keyboard for the language." },
};
function mountFieldTips(root) {
  root = root || document;
  Object.keys(FIELD_TIPS).forEach((id) => {
    const inp = root.getElementById ? root.getElementById(id) : document.getElementById(id);
    if (!inp) return;
    const wrap = inp.closest(".field") || inp.closest("label");
    if (!wrap || wrap.querySelector(":scope > .field-tip")) return;   // déjà monté
    wrap.classList.add("has-tip");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "field-tip";
    btn.dataset.tipId = id;
    btn.textContent = "ⓘ";
    btn.setAttribute("aria-label", t("tip.aria"));
    wrap.appendChild(btn);
  });
}
/** Ouvre/ferme le popover d'aide d'un champ. Un seul ouvert à la fois. */
function onFieldTipClick(e) {
  const btn = e.target.closest(".field-tip");
  document.querySelectorAll(".field-tip-pop").forEach((p) => { if (!btn || p._owner !== btn) p.remove(); });
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  if (btn._pop && btn._pop.isConnected) { btn._pop.remove(); btn._pop = null; return; }
  const tip = FIELD_TIPS[btn.dataset.tipId]; if (!tip) return;
  const pop = document.createElement("div");
  pop.className = "field-tip-pop";
  pop.textContent = getUiLang() === "en" ? (tip.en || tip.fr) : tip.fr;   // textContent = anti-injection
  pop._owner = btn; btn._pop = pop;
  const wrap = btn.closest(".field") || btn.closest("label");
  if (wrap) wrap.appendChild(pop);
}
function initContributeur() {
  setupVillageCombo();
  initIndicatifs();                       // remplit d'abord les options d'indicatif
  fillProfileFields();                    // (les <select> sont habillés ensuite, auto)

  const fields = ["#c-nom", "#c-prenom", "#c-village", "#c-role",
    "#c-email", "#c-indicatif", "#c-tel", "#c-consent",
    "#c-credit-on", "#c-credit-format"];
  fields.forEach((sel) => {
    const el = $(sel);
    el.addEventListener("change", collectContributeur);
    el.addEventListener("input", collectContributeur);
  });
  mountFieldTips();                        // infobulles ⓘ sur le profil ET la déclaration de langue
  document.addEventListener("click", onFieldTipClick);   // popover (un seul ouvert à la fois)
}

/** Remplit les champs du profil depuis le stockage (aussi utilisé pour annuler). */
function fillProfileFields() {
  const c = loadContributeur();
  $("#c-nom").value = c.nom || "";
  $("#c-prenom").value = c.prenom || "";
  $("#c-role").value = c.role || "";
  $("#c-email").value = c.email || "";
  $("#c-indicatif").value = c.indicatif || "";
  $("#c-tel").value = c.telephone || "";
  // Défaut pour un NOUVEAU profil (jamais enregistré) : les deux consentements COCHÉS + crédit
  // « prénom » (choix Brice 2026-07-23 : chacun est crédité publiquement par défaut ; libre de
  // décocher ensuite, son choix fait alors foi). Un profil déjà enregistré garde SES valeurs.
  const _isNewProfile = c.consentement === undefined && c.creditMode === undefined && !c.nom && !c.prenom;
  $("#c-consent").checked = _isNewProfile ? true : !!c.consentement;
  $("#c-village").value = c.village || "";
  $("#c-credit-on").checked = _isNewProfile ? true : !!(c.creditMode && c.creditMode !== "none");
  $("#c-credit-format").value = c.creditMode === "sigle" ? "sigle" : "prenom";
  refreshEnhancedSelects();
  updateConsentUI();
  updateCreditUI();
  renderProfileLangs();
}

function initEvents() {
  $("#dir-fr2nge").addEventListener("click", () => { direction = "fr2nge"; applyDirection(); });
  $("#dir-nge2fr").addEventListener("click", () => { direction = "nge2fr"; applyDirection(); });
  $("#btn-rec").addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
    else startRecording();
  });
  $("#btn-clear-audio").addEventListener("click", clearAudio);
  // Déplier la section optionnelle (l'utilisateur veut compléter son mot par l'autre volet).
  const addTr = $("#add-translation"); if (addTr) addTr.addEventListener("click", () => _revealOptional("#target-wrap", "#add-translation", "#target"));
  const addAu = $("#add-transcription"); if (addAu) addAu.addEventListener("click", () => _revealOptional("#audio-wrap", "#add-transcription", null));
  $("#btn-save").addEventListener("click", saveContribution);
  $("#btn-send").addEventListener("click", send);
  const sSearch = $("#send-search"); if (sSearch) sSearch.addEventListener("input", () => keepScroll(filterSendLists));
  // Détection de doublon quand l'utilisateur SAISIT lui-même un mot (mode libre).
  const srcEl = $("#source");
  if (srcEl) { let _dupT; srcEl.addEventListener("input", () => { clearTimeout(_dupT); _dupT = setTimeout(checkSourceDuplicate, 350); }); }
  const dupRedo = $("#dup-redo");
  if (dupRedo) dupRedo.addEventListener("click", () => {
    _dupOverride = normTxt(($("#source") || {}).value || "");   // il assume de refaire CE mot
    checkSourceDuplicate();
    const tg = activity === "transcribe" ? $("#btn-rec") : $("#target");
    if (tg) keepScroll(() => { try { tg.focus({ preventScroll: true }); } catch (e) { /* ok */ } });
  });
  const dupSkip = $("#dup-skip");
  if (dupSkip) dupSkip.addEventListener("click", () => {
    const s = $("#source"); if (s) { s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); }
    _dupOverride = ""; checkSourceDuplicate();
    if (s) keepScroll(() => { try { s.focus({ preventScroll: true }); } catch (e) { /* ok */ } });
  });
  const rs = $("#btn-resend"); if (rs) rs.addEventListener("click", () => { kickReconcile(); toast(t("toast.resend"), "ok"); });
  window.addEventListener("online", () => { updateServerBadge(); kickReconcile(); });   // retour réseau → renvoi auto
  window.addEventListener("offline", updateServerBadge);
  // Mode proposer / libre
  $("#mode-prop").addEventListener("click", () => { mode = "proposer"; applyMode(); });
  $("#mode-libre").addEventListener("click", () => { mode = "libre"; applyMode(); });
  $("#prop-cat").addEventListener("change", (e) => { propCat = e.target.value; loadProposition(); });
  $("#prop-next").addEventListener("click", loadProposition);
  // Navigation profil → accueil, puis accueil → espaces
  $("#btn-profile-continue").addEventListener("click", () => {
    if (!profileComplete()) return;
    pushUserProfile();   // tout profil complété remonte dans l'Excel, même sans contribution
    // La langue PRINCIPALE (1re des langues d'appartenance) devient la langue de travail.
    const primary = profileLangues()[0] || getCurrentLangId();
    if (primary && primary !== getCurrentLangId()) {
      // Changement de langue de travail → rechargement ; on vise l'ACCUEIL (sinon le
      // routeur restaurerait la vue profil courante, #/profil).
      setCurrentLangId(primary);
      try { history.replaceState(null, "", "#/accueil"); } catch (e) { /* ok */ }
      location.reload();
      return;
    }
    enterHub();
  });
  $("#btn-profile-cancel").addEventListener("click", () => {
    if (profileSnapshot) { saveContributeur(profileSnapshot); fillProfileFields(); updateGate(); }
    // Retour cohérent avec le verrou : profil complet → accueil ; sinon on revient à
    // l'étape précédente (choix de la langue), jamais sur un accueil inaccessible.
    if (profileComplete()) enterHub(); else openLangChoice();
  });
  // #btn-open-profile est maintenant une vraie ancre <a href="#/profil"> : la navigation
  // passe par hashchange (aucun handler direct nécessaire, cf. plus bas).
  // Cartes de l'accueil : VRAIES ancres <a href="#/…"> désormais (navigation via hashchange) ;
  // on garde seulement l'onde (ripple) lumineuse, effet purement visuel.
  document.querySelectorAll(".hub-card").forEach((card) =>
    card.addEventListener("click", (ev) => spawnRipple(card, ev))
  );
  // Onglets de navigation permanents : VRAIES ancres <a href="#/…"> désormais, la navigation
  // passe par l'écouteur hashchange global (plus de handler de clic direct ici).
  const rsl = $("#req-strip-list"); if (rsl) rsl.addEventListener("click", onReqStripClick);   // lot 5 : clic sur une demande
  const eCsv = $("#export-csv"); if (eCsv) eCsv.addEventListener("click", () => downloadDict("csv"));
  const eJson = $("#export-json"); if (eJson) eJson.addEventListener("click", () => downloadDict("json"));
  const eLift = $("#export-lift"); if (eLift) eLift.addEventListener("click", () => downloadDict("lift"));
  const eCldf = $("#export-cldf"); if (eCldf) eCldf.addEventListener("click", () => downloadDict("cldf"));
  const eElan = $("#export-elan"); if (eElan) eElan.addEventListener("click", () => downloadDict("elan"));
  // Page « À propos » (vraie vue de l'app, avec header/footer/fond partagés) : #about-link
  // est une vraie ancre <a href="#/apropos"> désormais, navigation via hashchange.
  const aboutBack = $("#about-back"); if (aboutBack) aboutBack.addEventListener("click", () => showView(_aboutReturn || "hub"));
  // #bugs-link idem : vraie ancre <a href="#/bugs">.
  const bugsBack = $("#bugs-back"); if (bugsBack) bugsBack.addEventListener("click", () => showView(_bugsReturn || "hub"));
  // Pages légales : liens du pied de page + navigation interne + retour.
  document.querySelectorAll(".foot-legal-link").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); openLegal(a.dataset.legal); }));
  const legalNav = $("#legal-nav");
  if (legalNav) legalNav.addEventListener("click", (e) => {
    const a = e.target.closest(".legal-navlink"); if (!a) return;
    e.preventDefault(); openLegal(a.dataset.sec);
  });
  const legalBack = $("#legal-back");
  if (legalBack) legalBack.addEventListener("click", () => routeTo(viewToRoute(_legalReturn) || "accueil"));
  const bugSend = $("#bug-send"); if (bugSend) bugSend.addEventListener("click", submitBug);
  // Invitation à contribuer : « Plus tard » et « Fermer » l'écartent pour la journée.
  const inLater = $("#incite-later"); if (inLater) inLater.addEventListener("click", _incDismiss);
  const inClose = $("#incite-close"); if (inClose) inClose.addEventListener("click", _incDismiss);
  // Notifications : cloche = vraie ancre <a href="#/notifications">, navigation via hashchange.
  // (retour, tout marquer comme lu, popup restent des actions, pas de la navigation.)
  const nBack = $("#notif-back"); if (nBack) nBack.addEventListener("click", () => showView(_notifsReturn || "hub"));
  const nMark = $("#notif-markall"); if (nMark) nMark.addEventListener("click", markNotifsRead);
  // Une notification est CLIQUABLE : elle mène là où agir (répondre à une demande, ou
  // ouvrir le mot concerné dans Explorer). Corrige BUG-U-mrtcyz9u-8933.
  const nFeed = $("#notif-feed");
  if (nFeed) {
    nFeed.addEventListener("click", (e) => { const li = e.target.closest(".notif"); if (li) onNotifAction(li); });
    nFeed.addEventListener("keydown", (e) => {
      const li = e.target.closest(".notif");
      if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onNotifAction(li); }
    });
  }
  // Popup de notif : « Ouvrir » agit directement si la notif est actionnable (demande →
  // y répondre), sinon ouvre le centre de notifications.
  const npGo = $("#notif-popup-go"); if (npGo) npGo.addEventListener("click", () => {
    const n = _popupNotif;
    // Action cliquée → ce popup ne revient plus (marqué au timestamp de la notif).
    if (n) { try { localStorage.setItem(NOTIF_POPUP_KEY, String(n.ts || Date.now())); } catch (e) { /* ok */ } }
    _notifPopupClose();
    if (n && notifActionable(n)) { routeNotif(n.type, n.data || {}); return; }
    openNotifs();
  });
  const npLater = $("#notif-popup-later"); if (npLater) npLater.addEventListener("click", _notifPopupClose);
  const npClose = $("#notif-popup-close"); if (npClose) npClose.addEventListener("click", _notifPopupClose);
  // Porte « Demander » : publier une demande, retour, filtre langue, réponses/partage.
  const rSend = $("#req-send"); if (rSend) rSend.addEventListener("click", submitRequest);
  const rBack = $("#req-back"); if (rBack) rBack.addEventListener("click", () => showView(_reqReturn || "hub"));
  const rFilt = $("#req-filter-lang"); if (rFilt) rFilt.addEventListener("change", renderRequests);
  const rList = $("#req-list"); if (rList) rList.addEventListener("click", onReqListClick);
  const rLang = $("#req-langue"); if (rLang) rLang.addEventListener("change", _onReqLangueChange);
  const rNl = $("#req-nl-declare"); if (rNl) rNl.addEventListener("click", _declareNewLangForRequest);
  ["#req-nl-nom", "#req-nl-region", "#req-nl-pays"].forEach((s) => { const el = $(s); if (el) el.addEventListener("input", () => { _reqNlConfirmDup = false; const e = $("#req-nl-error"); if (e) e.hidden = true; }); });
  const upNow = $("#update-now"); if (upNow) upNow.addEventListener("click", doUpdate);
  const upLater = $("#update-later"); if (upLater) upLater.addEventListener("click", () => {
    const dep = $("#update-ver") ? $("#update-ver").textContent.trim() : "";
    if (dep) localStorage.setItem("updateDismissed", dep);   // écartée pour CETTE version (une plus récente rouvrira)
    _hideBanner();
  });
  // Vérifie une nouvelle version : au retour sur l'app + périodiquement.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
  setInterval(checkForUpdate, 120000);
  const aboutStart = $("#about-start"); if (aboutStart) aboutStart.addEventListener("click", () => { if (profileComplete()) enterHub(); else openProfile(false); });
  const micTestBtn = $("#btn-mic-test");
  if (micTestBtn) micTestBtn.addEventListener("click", testMic);
  // Bouton « Accueil » du header : vraie ancre <a href="#/accueil">, navigation via hashchange.
  // Bascule de la langue d'INTERFACE (FR ⇄ EN), distincte de la langue de contenu.
  const uiToggle = $("#ui-lang-toggle");
  if (uiToggle) uiToggle.dataset.active = getUiLang();   // moitié verte = langue active (capsule FR|EN)
  if (uiToggle) uiToggle.addEventListener("click", () => {
    // Bascule de langue d'INTERFACE : on recharge pour que TOUT se reconstruise
    // dans la nouvelle langue (y compris les <select> habillés, la visite guidée, etc.).
    setUiLang(getUiLang() === "en" ? "fr" : "en");
    location.reload();
  });
  // Sélecteur de langue (header) : vraie ancre <a href="#/langue">, navigation via hashchange.
  const ldSubmit = $("#ld-submit"); if (ldSubmit) ldSubmit.addEventListener("click", submitDeclareLang);
  // Couche 3 : correction de la langue d'une de SES contributions (délégation de clic).
  const mcList = $("#mc-list");
  if (mcList) mcList.addEventListener("click", (e) => {
    const play = e.target.closest(".mc-play");
    if (play) { e.preventDefault(); const u = play.dataset.audio; if (u) keepScroll(() => _mcPlay(play, u)); return; }

    const editTrad = e.target.closest(".mc-edit-trad");
    if (editTrad) { e.preventDefault(); const item = editTrad.closest(".mc-item"); const box = item && item.querySelector(".mc-trad-edit");
      if (box) { keepScroll(() => { box.hidden = false; const inp = box.querySelector(".mc-trad-input"); if (inp) inp.focus(); }); } return; }

    const editVoice = e.target.closest(".mc-edit-voice");
    if (editVoice) { e.preventDefault(); const item = editVoice.closest(".mc-item"); const box = item && item.querySelector(".mc-voice-edit");
      if (box) keepScroll(() => { box.hidden = false; }); return; }

    const cancel = e.target.closest(".mc-edit-cancel");
    if (cancel) { e.preventDefault(); const box = cancel.closest(".mc-trad-edit, .mc-voice-edit"); if (box) keepScroll(() => { box.hidden = true; }); return; }

    const saveTrad = e.target.closest(".mc-edit-save-trad");
    if (saveTrad) {
      e.preventDefault();
      const item = saveTrad.closest(".mc-item"); const box = saveTrad.closest(".mc-trad-edit");
      const inp = box && box.querySelector(".mc-trad-input");
      if (item && inp) _mcSaveText(item.dataset.sid, inp.value, item, box);
      return;
    }

    const voiceRec = e.target.closest(".mc-voice-rec");
    if (voiceRec) { e.preventDefault(); _mcToggleVoiceRec(voiceRec); return; }

    const saveVoice = e.target.closest(".mc-edit-save-voice");
    if (saveVoice) {
      e.preventDefault();
      const item = saveVoice.closest(".mc-item"); const box = saveVoice.closest(".mc-voice-edit");
      if (item && box && box._mcBlob) _mcSaveVoice(item.dataset.sid, box._mcBlob, box._mcDur || 0, item, box);
      return;
    }

    const b = e.target.closest(".mc-save"); if (!b) return;
    const item = b.closest(".mc-item"); if (!item) return;
    const sel = item.querySelector(".mc-lang-sel");
    _mcSave(item.dataset.sid, sel ? sel.value : "", item);
  });
  // Suggestions de langues proches EN DIRECT à la saisie (anti-doublon).
  ["#ld-nom", "#ld-region", "#ld-pays", "#ld-autonyme", "#ld-alias"].forEach((s) => {
    const e = $(s); if (e) e.addEventListener("input", onDeclareInput);
  });
  // Écran des langues : recherche + bouton « déclarer » distinct en haut.
  const ldBtn = $("#lang-declare-btn"); if (ldBtn) ldBtn.addEventListener("click", openDeclareForm);
  const ldSearch = $("#lang-search");
  if (ldSearch) {
    ldSearch.addEventListener("input", (e) => filterLangGrid(e.target.value));
    // Entrée dans le champ = lancer la recherche (comme le bouton).
    ldSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") filterLangGrid(ldSearch.value); });
  }
  const ldSearchBtn = $("#lang-search-btn");
  if (ldSearchBtn) ldSearchBtn.addEventListener("click", () => {
    filterLangGrid(ldSearch ? ldSearch.value : "");
    if (ldSearch) { try { ldSearch.focus(); } catch (e) { /* ok */ } }
  });
  // Consignes : « J'ai compris » ferme ; « Revoir les consignes » rouvre celles de
  // l'activité EN COURS (Transcrire ou Traduire).
  const trOk = $("#tr-guide-ok");
  if (trOk) trOk.addEventListener("click", hideGuide);
  // Popup de redirection profil : « Créer mon profil » ferme et laisse sur le profil ;
  // « Plus tard » ferme et revient à l'accueil.
  const pgOk = $("#pg-ok"); if (pgOk) pgOk.addEventListener("click", hideProfileGate);
  const pgLater = $("#pg-later"); if (pgLater) pgLater.addEventListener("click", () => { hideProfileGate(); showView("hub"); });
  // Deux boutons « Revoir les consignes » (zone audio en Transcrire, ligne du label
  // Traduction en Traduire) — un seul visible à la fois selon le mode.
  document.querySelectorAll(".tr-guide-open").forEach((el) =>
    el.addEventListener("click", () => showGuide(activity)));
  // Amorce sonore (premières voix d'une langue créée)
  const amRec = $("#amorce-rec-btn"); if (amRec) amRec.addEventListener("click", amorceRecToggle);
  const amSkip = $("#amorce-skip"); if (amSkip) amSkip.addEventListener("click", amorceSkip);
  const amVal = $("#amorce-validate"); if (amVal) amVal.addEventListener("click", amorceValidate);
  const amFin = $("#amorce-finish"); if (amFin) amFin.addEventListener("click", amorceFinish);
  const ldCancel = $("#ld-cancel"); if (ldCancel) ldCancel.addEventListener("click", () => {
    const er = $("#ld-error"); if (er) er.hidden = true;
    restoreDeclareHome();       // rend le formulaire à l'écran des langues (il a pu être déplacé dans le profil)
    if (_declareCtx === "profile") { const p = $("#profile-langs"); if (p) p.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    _declareCtx = null;
  });
  // Logo + nom (header ET footer) : vraies ancres <a href="#/accueil"> désormais (clic droit
  // → « ouvrir dans un nouvel onglet » fonctionne). Clic gauche/clavier (Entrée, natif sur <a>)
  // passent par hashchange ; plus de handler direct nécessaire.
  // Mode présentation (plein écran)
  // Témoignage « Laisser un mot » : ouvrir / publier / annuler.
  const tOpen = $("#testi-open"); if (tOpen) tOpen.addEventListener("click", showTestimonialForm);
  const tSend = $("#testi-send"); if (tSend) tSend.addEventListener("click", submitTestimonialForm);
  const tCancel = $("#testi-cancel"); if (tCancel) tCancel.addEventListener("click", hideTestimonialForm);
  const presentOpen = $("#present-open"); if (presentOpen) presentOpen.addEventListener("click", openPresent);
  const presentClose = $("#present-close"); if (presentClose) presentClose.addEventListener("click", closePresent);
  const dlPng = $("#present-dl-png"); if (dlPng) dlPng.addEventListener("click", () => downloadPresent("png"));
  const dlPdf = $("#present-dl-pdf"); if (dlPdf) dlPdf.addEventListener("click", () => downloadPresent("pdf"));
  // Routeur : le bouton Précédent/Suivant du navigateur rejoue la vue correspondante.
  window.addEventListener("popstate", onHistoryNav);
  // Les contrôles de navigation sont maintenant de VRAIES ancres <a href="#/route"> (clic droit
  // → « ouvrir dans un nouvel onglet » fonctionne, comme sur la plupart des sites). Un clic gauche
  // change donc le hash nativement ; hashchange route la vue. Couvre aussi les liens du pied de
  // page (déjà de vraies ancres) qui ne déclenchaient rien au clic faute d'écouteur.
  window.addEventListener("hashchange", onHistoryNav);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#present") && !$("#present").hidden) closePresent();
  });
  // Si l'utilisateur quitte le plein écran (Échap système), on referme aussi l'overlay.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && $("#present") && !$("#present").hidden) $("#present").hidden = true;
  });
}

// --- Voile de chargement (boot / rechargement) ---------------------------
function hideAppLoader() {
  const el = document.getElementById("app-loader");
  if (el) el.classList.add("app-loader--hide");
  document.body.classList.remove("is-busy");
}
function showAppLoader() {
  const el = document.getElementById("app-loader");
  if (el) el.classList.remove("app-loader--hide");
  document.body.classList.add("is-busy");
}

async function main() {
  setTimeout(hideAppLoader, 6000);   // filet : jamais bloqué sur le voile même si une étape traîne
  initTheme();
  const ver = $("#app-ver");
  if (ver) ver.textContent = APP_VERSION;
  initContributeur();
  applyCreditDefaultOnce();   // crédit public par défaut « oui/prénom » appliqué UNE fois aux profils existants
  initKeyboard();
  initKeyboardReveal();
  initPropCategories();
  applyI18n();       // langue d'INTERFACE (FR/EN) sur tout le DOM statique marqué —
                     // AVANT d'habiller les <select> pour qu'ils prennent la bonne langue
  updateFlyerLinks();   // flyer téléchargeable dans la langue + le thème de l'utilisateur
  if (getUiLang() === "en") await ensureSourceEn();   // équivalents FR→EN prêts avant le 1er rendu (jamais de FR affiché à un anglophone)
  initSelectAutoEnhance();                // habille TOUS les <select> (auto, présents + futurs)
  initEvents();
  applyLanguage();   // applique la langue courante (libellés + clavier dédié/défaut) + sens
  mode = localStorage.getItem("modeSaisie") || "proposer"; // défaut : proposer
  applyMode();
  updateGate();
  setActivity(localStorage.getItem("activity") || "translate");
  // Démarrage / RAFRAÎCHISSEMENT :
  //  - aucune langue → écran « Choisis ta langue » (seule contrainte dure au chargement) ;
  //  - langue choisie → on RESTE sur l'écran demandé par l'URL (rafraîchir garde la page).
  // On NE force PLUS le profil au chargement : le verrou de profil ne s'applique qu'aux
  // ACTIONS (Traduire/Transcrire/Explorer/déclarer), via requireProfile ; routeTo() renvoie
  // donc au profil seulement si la route demandée est une action réservée.
  _replayingHistory = true;
  // Nouveau parcours d'accueil : on atterrit TOUJOURS sur le hub (les 4 portes), jamais sur
  // l'écran des langues. La langue et le profil ne sont demandés qu'au MOMENT d'une action qui
  // écrit des données (via requireProfile). Un lien profond restaure sa page.
  const route = hashToRoute();   // ex. #/apropos, #/explorer → on restaure cette page
  if (route) routeTo(route); else enterHub();
  _replayingHistory = false;
  hideAppLoader();      // 1re vue affichée → on lève le voile (les rafraîchissements ci-dessous suivent en fond)
  // Init NON critique différée APRÈS le 1er rendu (allège la longue tâche de boot) : visite guidée,
  // outil de découpe audio, barres de partage. Aucun ne démarre seul (uniquement des écouteurs /
  // du DOM à la demande) → sûr à monter un instant plus tard.
  idleInit(() => { try { initTour(); initTrim(); mountShareBars(); } catch (e) { /* jamais bloquant */ } });
  refreshLanguages();   // best-effort : récupère les langues déclarées par la communauté
  micStatus();
  $("#send-hint").textContent = t("send.hint");
  await refreshDoneTexts();   // reconstruit « déjà traité par cet utilisateur » depuis ses contributions
  await refresh();
  await updateServerBadge();
  scheduleReconcile();   // au chargement : s'il reste des items non confirmés, la boucle de renvoi reprend d'elle-même
  verifyUpdateApplied();   // filet ultime : si une mise à jour venait d'être lancée, on confirme qu'elle a bien pris (sinon relance bornée)
  // enregistre le service worker (hors-ligne) + détecte une nouvelle version
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      // un nouveau SW s'installe → une nouvelle version est là
      reg.addEventListener("updatefound", () => checkForUpdate());
      if (reg.waiting) checkForUpdate();
    } catch (e) { /* ignore */ }
  }
  setTimeout(checkForUpdate, 2500);   // 1re vérification de version, peu après le chargement
}

// Indique l'état du micro au chargement (le blocage HTTPS/localhost est fréquent)
function micStatus() {
  const rs = $("#rec-state");
  if (!window.isSecureContext) {
    rs.textContent = t("boot.mic.insecure");
  } else if (!navigator.mediaDevices || !window.MediaRecorder) {
    rs.textContent = t("boot.mic.unsupported");
  } else {
    rs.textContent = "";
  }
}

main();
