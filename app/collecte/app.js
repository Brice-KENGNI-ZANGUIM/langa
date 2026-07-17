// Application de collecte Nguiemboo — logique principale.
import { NgiemboonKeyboard } from "../keyboard/ngiemboon-keyboard.js";
import { PredictNgiemboon } from "./predict.js";
import { mountAudioPlayer } from "./audioplayer.js";
import { sliceSamples, encodeWavBytes, detectSilenceBounds, samplesDuration } from "./audiotrim.js";
import { sourceEn } from "./source_en.js";
import { DB } from "./db.js";
import { reconcile, checkServer, serverStats, modeGoogle, browseLibrary,
  fetchSuggestions, postSuggestion, postVote, postBug, fetchBugs,
  fetchLanguages, declareLanguage, declareUser, fetchDriveAudio,
  proposeMerge, respondMerge, mergesForDevice } from "./sync.js";
import { PROPOSITIONS } from "./propositions.js";
import { BUGS } from "./bugs.js";
import { CONFIG } from "./config.js";
import { currentLang, getCurrentLangId, setCurrentLangId, usesDedicatedKeyboard,
  hasChosenLang, knownLanguages, cacheRemoteLanguages, langAlphabet } from "./languages.js";
import { applyI18n, getUiLang, setUiLang, t, tToast } from "./i18n.js";
import { entriesToCSV, entriesToJSON, exportFilename } from "./export.js";
import { shareCardText, shareTitle, mountShareBar } from "./share.js";
import { findSimilarLanguages } from "./langsim.js";
import { findDuplicatePairs, pickCanonical, resolveCanonicalId, visibleLanguages } from "./langmerge.js";
import { AMORCE, AMORCE_MIN } from "./amorce.js";

const $ = (sel) => document.querySelector(sel);
const nfc = (s) => (s || "").normalize("NFC");

// Version affichée dans l'en-tête : permet de vérifier d'un coup d'œil que le
// téléphone charge bien la DERNIÈRE version (et non une copie en cache). À garder
// synchrone avec CACHE dans sw.js.
const APP_VERSION = "v192";
// Espace courant : "translate" (Traduire) ou "transcribe" (Transcrire).
let activity = "translate";
// Vue affichée (pour la visite guidée contextuelle).
let _currentView = "profile";
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
  if (add) add.addEventListener("click", () => {
    // Déclarer une nouvelle langue depuis le profil : possible dès que les champs
    // obligatoires sont remplis (requireProfile passe), sinon on invite à les finir.
    if (!requireProfile("Termine d'abord les champs obligatoires du profil pour déclarer une langue.")) return;
    openLangChoice();
    const dc = $("#lang-declare"); if (dc) { dc.hidden = false; dc.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    const n = $("#ld-nom"); if (n) { try { n.focus(); } catch (e) {} }
  });
}

// --- État ----------------------------------------------------------------
let direction = "fr2nge"; // fr2nge | nge2fr
let mode = "proposer";    // proposer | libre  (défaut : proposer)
let propCat = "auto";     // "auto" = progression ordonnée ; sinon un groupe précis
let currentProp = null;   // proposition en cours {id, cat, texte}
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
  const chipName = $("#lang-chip-name"); if (chipName) chipName.textContent = L.nom;
  applyDirection();
}
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
const GROUP_ORDER = ["mots", "phrases", "lettres", "chiffres", "nombres", "dictionnaire"];
let _BY_CAT = null;
function byCat() {
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
  const c = (PROPOSITIONS.categories || []).find((x) => x.key === key);
  return c ? c.label : key;
}
/** Premier groupe (dans l'ORDRE) ayant encore des items non faits par l'user. */
function firstUndoneGroup() {
  for (const k of GROUP_ORDER) { if (groupUndone(k).length > 0) return k; }
  return null;
}
/** Groupe actif : choix manuel s'il reste des items, sinon le premier groupe
    non épuisé dans l'ordre (auto-avance + retour sur mise à jour). */
function resolveGroup() {
  if (propCat && propCat !== "auto" && groupUndone(propCat).length > 0) return propCat;
  return firstUndoneGroup();
}
function initPropCategories() {
  const sel = $("#prop-cat");
  const opts = [`<option value="auto">${t("prop.auto")}</option>`].concat(
    PROPOSITIONS.categories.map((c) => `<option value="${c.key}">${groupLabel(c.key)} (${c.n})</option>`)
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
}
let _lastGroup = null;
function loadProposition() {
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
  $("#prop-progress").textContent = `${groupLabel(group)} · ${faits} / ${total} ${verb}`;
  // Annonce le passage AUTOMATIQUE au groupe suivant (quand le précédent est fini).
  if (_lastGroup && _lastGroup !== group && groupUndone(_lastGroup).length === 0) {
    toast(`Groupe « ${groupLabel(_lastGroup)} » terminé, on continue avec « ${groupLabel(group)} ».`, "ok");
  }
  _lastGroup = group;
  // Tirage AU HASARD parmi les restants du groupe.
  currentProp = restants[Math.floor(Math.random() * restants.length)];
  const src = $("#source");
  src.dataset.canon = currentProp.texte;            // #48 : on STOCKE le mot canonique (français)…
  src.value = sourceDisplay(currentProp.texte);     // …et on AFFICHE dans la langue d'interface (EN si l'utilisateur y est passé)
  src.dispatchEvent(new Event("input", { bubbles: true }));
  $("#target").value = "";
  $("#target").focus();
}
/** #48 : texte de l'item source à AFFICHER, dans la langue d'interface. En anglais, on
    montre l'équivalent connu (nombres, lettres, parenté…) ; sinon on garde le français
    (aucune invention). Le mot canonique stocké reste le français, cf. loadProposition. */
function sourceDisplay(fr) {
  if (getUiLang() !== "en") return fr;
  return sourceEn(fr) || fr;
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
  else { const s = $("#source"); s.value = ""; delete s.dataset.canon; s.placeholder = t("wk.source.ph"); currentProp = null; }
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
    toast("L'enregistrement audio exige HTTPS ou localhost (sécurité du navigateur). "
      + "En local, ouvre http://localhost:8765/ ; une fois l'app en ligne (HTTPS), "
      + "le micro marchera sur les téléphones.", "warn");
    renderMicDiag(micStaticInfo(), "?", false, "insecure");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    rs.textContent = t("rec.unsupported");
    toast("Ce navigateur ne supporte pas l'enregistrement audio. Essaie Chrome ou Firefox à jour.", "warn");
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
  stopRecTimer();
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
  const bt = $("#btn-trim-audio");
  if (audioBlob) {
    mountLocalAudioPlayer(wrap, URL.createObjectURL(audioBlob), audioDurationMs);
    $("#btn-clear-audio").hidden = false;
    if (bt) bt.hidden = false;
  } else {
    $("#btn-clear-audio").hidden = true;
    if (bt) bt.hidden = true;
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
  _trimChannels = null; _trimDrag = null;
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
function drawTrimWave() {
  const cv = $("#trim-wave"); if (!cv || !_trimChannels || _trimTotal <= 0) return;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, mid = H / 2;
  const cs = getComputedStyle(document.documentElement);
  const cyan = (cs.getPropertyValue("--cyan") || "#22d3ee").trim();
  const muted = (cs.getPropertyValue("--muted") || "#88a").trim();
  g.clearRect(0, 0, W, H);
  const ch = _trimChannels[0] || new Float32Array(0), n = ch.length;
  g.strokeStyle = muted; g.globalAlpha = 0.7; g.beginPath();
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor(x / W * n), i1 = Math.floor((x + 1) / W * n);
    let mx = 0; for (let i = i0; i < i1; i++) { const v = Math.abs(ch[i] || 0); if (v > mx) mx = v; }
    const h = mx * (mid - 4);
    g.moveTo(x + 0.5, mid - h); g.lineTo(x + 0.5, mid + h);
  }
  g.stroke(); g.globalAlpha = 1;
  const xa = _trimStart / _trimTotal * W, xb = _trimEnd / _trimTotal * W;
  g.fillStyle = cyan; g.globalAlpha = 0.16; g.fillRect(xa, 0, Math.max(0, xb - xa), H); g.globalAlpha = 1;
  g.strokeStyle = cyan; g.lineWidth = 2; g.fillStyle = cyan;
  for (const x of [xa, xb]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillRect(x - 3, mid - 13, 6, 26); }
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
function trimPlaySelection() {
  const sel = trimSelectionBlob();
  if (!sel) { toast(t("trim.empty"), "warn"); return; }
  const a = $("#trim-audio"); if (!a) return;
  if (a._url) URL.revokeObjectURL(a._url);
  a._url = URL.createObjectURL(sel.blob); a.src = a._url;
  a.play().catch(() => { /* geste utilisateur requis parfois : sans gravité */ });
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
    toast("Remplis d'abord ton profil (tous les champs marqués *).", "warn");
    openProfile(true);
    return;
  }
  if (activity === "transcribe") {
    if (!source) { toast("Écris ou fais-toi proposer le mot/phrase à prononcer.", "warn"); return; }
    if (!audioBlob) { toast("Enregistre ta voix : c'est l'essentiel d'une transcription.", "warn"); return; }
  } else if (!source || !target) {
    toast("Renseigne le mot/phrase ET sa traduction.", "warn");
    return;
  }

  const fr2nge = direction === "fr2nge";
  const lid = getCurrentLangId();   // langue cible communautaire (nge, bassa, …)
  const rec = {
    client_id: (crypto.randomUUID && crypto.randomUUID()) || "c-" + Date.now(),
    direction,
    langue: lid,
    source_lang: fr2nge ? "fr" : lid,
    target_lang: fr2nge ? lid : "fr",
    source_text: source,
    target_text: target,
    domaine: $("#domaine").value.trim(),
    note: $("#note").value.trim(),
    contributeur: c,
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
  }
  await DB.put(rec);
  markDoneText(rec.source_text);   // cet item ne sera plus proposé à CET utilisateur
  if (mode === "proposer" && currentProp) {
    loadProposition(); // enchaîne un item NON encore traité (tirage aléatoire)
  } else {
    resetForm();
  }
  await refresh();
  kickReconcile();            // tente l'envoi tout de suite, puis en boucle jusqu'à confirmation
  toast("Contribution enregistrée localement.", "ok");
  celebrate($("#btn-save"));  // micro-célébration sobre (halo + confettis Ndop)
}

function resetForm() {
  $("#source").value = "";
  delete $("#source").dataset.canon;   // #48 : pas de mot canonique résiduel
  $("#target").value = "";
  $("#domaine").value = "";
  $("#note").value = "";
  clearAudio();
  $("#source").focus();
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
function profileComplete() {
  const c = loadContributeur();
  return !!(c.nom && c.prenom && c.village && c.role &&
            c.telephone && c.consentement);
}

/** Garde FAIL-CLOSED : toute action de contribution (Traduire, Transcrire, Explorer,
    déclarer une langue) exige un profil complet. Sans profil, on n'ouvre PAS l'action ;
    on emmène l'utilisateur vers la création de profil avec une explication claire, et on
    renvoie `false` pour que l'appelant s'interrompe. La SÉLECTION d'une langue reste
    autorisée sans profil (concession voulue) — seules les ACTIONS sont verrouillées. */
function requireProfile(reason) {
  if (profileComplete()) return true;
  toast(reason || "Crée d'abord ton profil : il ouvre l'accès à toutes les activités.", "warn");
  openProfile(false);
  return false;
}

let profileSnapshot = null; // sauvegarde pour « Annuler » en mode édition

// --- Routeur d'URL (hash) : une adresse par écran, Précédent/Suivant, liens profonds ---
// L'app est une SPA (une seule page). Pour se comporter comme les grandes apps web, on
// reflète la vue courante dans l'URL via un hash (#/explorer, #/apropos…). `showView`
// reste l'UNIQUE autorité : à chaque changement de vue, il synchronise le hash. Le bouton
// Précédent/Suivant (popstate) rejoue la route ; un rafraîchissement ou un lien profond
// restaure la même vue (sous réserve du VERROU de profil, qui garde la priorité).
const ROUTE_OF_VIEW = { hub: "accueil", explore: "explorer", about: "apropos",
  bugs: "bugs", profile: "profil", lang: "langue" };
const VIEW_OF_ROUTE = { accueil: "hub", traduire: "app", transcrire: "app",
  explorer: "explore", apropos: "about", bugs: "bugs", profil: "profile", langue: "lang" };
let _replayingHistory = false;   // vrai pendant le rejeu (initial/back/forward) → pas de pushState

/** Route canonique d'une vue (l'espace app dépend de l'activité Traduire/Transcrire). */
function viewToRoute(name) {
  if (name === "app") return activity === "transcribe" ? "transcrire" : "traduire";
  return ROUTE_OF_VIEW[name] || null;   // amorce/present : non routés (transitoires)
}
/** Route demandée par l'URL courante (ou null si aucune/inconnue). */
function hashToRoute() {
  const h = (location.hash || "").replace(/^#\/?/, "").trim();
  return VIEW_OF_ROUTE[h] ? h : null;
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
  if (targetView === _currentView) {
    if (targetView !== "app") return;
    const wantAct = route === "transcrire" ? "transcribe" : "translate";
    if (wantAct === activity) return;
  }
  switch (route) {
    case "accueil": enterHub(); break;
    case "traduire": enterWork("translate"); break;
    case "transcrire": enterWork("transcribe"); break;
    case "explorer": enterExplore(); break;
    case "apropos": openAbout(); break;
    case "bugs": openBugs(); break;
    case "profil": openProfile(profileComplete()); break;
    case "langue": openLangChoice(); break;
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
  const nav = $("#main-nav");
  if (nav) nav.hidden = (name === "lang" || name === "amorce" || name === "profile" || name === "hub" || name === "about" || name === "bugs");
  // « Mon profil » : visibilité conditionnée UNIQUEMENT à l'existence d'un profil.
  // Il reste donc affiché sur TOUTES les pages, y compris la vue profil elle-même
  // (il y sert de repère et n'a jamais à disparaître). Sans profil : rien à ouvrir.
  const prof = $("#btn-open-profile");
  if (prof) prof.hidden = !profileComplete();
  // Sélecteur de langue : visible dès qu'une langue est choisie, partout, sans exception.
  const lc = $("#lang-chip");
  if (lc) lc.hidden = !hasChosenLang();
  window.scrollTo(0, 0);
}

/** Ouvre la page « À propos » (vraie vue de l'app) en mémorisant d'où l'on vient. */
function openAbout() {
  if (_currentView !== "about") _aboutReturn = _currentView;
  showView("about");
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
async function submitBug() {
  const titre = $("#bug-titre").value.trim();
  const desc = $("#bug-desc").value.trim();
  if (!titre) { toast("Donne au moins un titre au bug.", "warn"); return; }
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
  toast("Bug signalé, merci ! Tu peux suivre son avancement ici.", "ok");
}

/** Ouvre la vue profil. edit=true → mode modification (depuis l'app). */
function openProfile(edit) {
  profileSnapshot = edit ? loadContributeur() : null;
  // Pré-remplit les langues d'appartenance avec la langue déjà choisie (si aucune encore).
  const c = loadContributeur();
  if ((!Array.isArray(c.langues) || c.langues.length === 0) && hasChosenLang()) {
    addProfileLangue(getCurrentLangId());
  }
  renderProfileLangs();
  $("#profile-title").textContent = edit ? t("profile.title.edit") : t("profile.title.welcome");
  // Le profil est OPTIONNEL (navigation libre) : « Annuler » est toujours proposé pour
  // revenir à la consultation sans être piégé sur cet écran.
  $("#btn-profile-cancel").hidden = false;
  $("#btn-profile-continue").textContent = edit ? t("profile.save") : t("profile.continue");
  showView("profile");
  updateProfileGate();
}

/** Remonte le PROFIL courant vers la base (best-effort, offline-safe) : tout profil
    complété doit apparaître dans l'Excel, même sans la moindre contribution. Upsert
    idempotent par device_id, sans compter de contribution. */
function pushUserProfile() {
  const c = loadContributeur();
  if (!c.consentement) return;   // pas de remontée sans consentement explicite
  try {
    declareUser({
      device_id: deviceId(),
      consentement: !!c.consentement,
      langues: Array.isArray(c.langues) && c.langues.length ? c.langues : [getCurrentLangId()],
      contributeur: c,
    }).catch(() => {});
  } catch (e) { /* offline : sans gravité, retenté au prochain enregistrement de profil */ }
}

/** Écran d'accueil « Que veux-tu faire ? » (profil complet requis). */
function enterHub() {
  collectContributeur();
  const c = loadContributeur();
  const nom = c.prenom || c.nom || "";
  $("#welcome-user").textContent = nom ? `${t("hub.greeting.hello")} ${nom} 👋` : "";
  const ht = $("#hub-title");
  if (ht) ht.textContent = nom ? `${t("hub.greeting.hello")} ${nom} 👋 · ${t("hub.greeting")}` : t("hub.greeting.solo");
  showView("hub");
}
/** Accueil = le hub aux trois portes (Traduire, Transcrire, Explorer). Si le profil
    n'est pas encore complet, l'accueil obligatoire reste la vue Profil (aucun
    contournement de l'onboarding). Branché sur le logo + le nom (header ET footer). */
function goHome() {
  // Parcours verrouillé : d'abord CHOISIR sa langue (autorisé sans profil), puis
  // CRÉER son profil (obligatoire) — ensuite seulement l'accueil des trois portes.
  if (!hasChosenLang()) openLangChoice();
  else if (!profileComplete()) openProfile(false);
  else enterHub();
}

// --- Choix / déclaration de LANGUE (plateforme communautaire) --------------
/** Ouvre l'écran de choix de langue (1er accès + via le sélecteur d'en-tête). */
function openLangChoice() {
  const dc = $("#lang-declare"); if (dc) dc.hidden = true;
  const er = $("#ld-error"); if (er) er.hidden = true;
  renderLangChoice();
  showView("lang");
}
/** Peint la grille des langues connues (graine + déclarées) + la carte « déclarer ». */
function renderLangChoice() {
  const grid = $("#lang-grid");
  if (!grid) return;
  const cur = getCurrentLangId();
  // Les langues fusionnées dans une autre ne s'affichent plus dans la grille (Phase C).
  const cards = visibleLanguages(knownLanguages()).map((l) => {
    const emb = escapeHtml((l.nom || "?").trim().slice(0, 1).toUpperCase() || "?");
    const kb = (usesDedicatedKeyboard(l.id) ? t("lang.dedicated") : t("lang.standard"))
      + (l.provisoire ? t("lang.provisoire") : "");
    // Chaîne de recherche normalisée (nom + autonyme + région), sans accents/casse.
    const search = normSearch([l.nom, l.autonyme, l.region].filter(Boolean).join(" "));
    return `<button class="lang-card${l.id === cur ? " is-current" : ""}" type="button" role="listitem" data-lang="${escapeHtml(l.id)}" data-search="${escapeHtml(search)}">
      <span class="lang-emblem" aria-hidden="true">${emb}</span>
      <span class="lang-name">${escapeHtml(l.nom)}</span>
      ${l.autonyme ? `<span class="lang-autonym">${escapeHtml(l.autonyme)}</span>` : ""}
      ${l.region ? `<span class="lang-region">${escapeHtml(getUiLang() === "en" && l.region_en ? l.region_en : l.region)}</span>` : ""}
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
function openDeclareForm() {
  // DÉCLARER une langue exige un profil (contrairement à la simple SÉLECTION).
  if (!requireProfile("Crée ton profil pour pouvoir déclarer une nouvelle langue.")) return;
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
function slugLang(nom) {
  let s = (nom || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) s = "langue";
  const ids = new Set(knownLanguages().map((l) => l.id));
  let id = s, n = 2;
  while (ids.has(id)) id = s + "-" + (n++);
  return id;
}
/** POST best-effort de la déclaration au backend (visible par tous). Silencieux si
    le backend n'est pas joignable : la langue reste dispo en local en attendant. */
function declareLanguageRemote(desc) {
  try { declareLanguage(desc).catch(() => {}); } catch (e) { /* offline : sans gravité */ }
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
  if (!nom || !region) {
    if (er) { er.textContent = "Le nom de la langue et la région sont obligatoires."; er.hidden = false; }
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
  const desc = { id, nom, region, pays, autonyme, alias: q.alias, famille, clavier: "defaut", statut: "active" };
  // Registre local (visible tout de suite) = langues déjà déclarées (avec leurs champs) + la nouvelle.
  const others = knownLanguages().filter((l) => !l.graine);
  others.push(desc);
  cacheRemoteLanguages(others);
  declareLanguageRemote(Object.assign({ note }, desc));   // POST best-effort : la langue est créée d'emblée
  addProfileLangue(id);                                   // la langue déclarée devient une langue d'appartenance
  // reset du formulaire
  ["#ld-nom", "#ld-region", "#ld-pays", "#ld-autonyme", "#ld-alias", "#ld-famille", "#ld-note"].forEach((s) => { const e = $(s); if (e) e.value = ""; });
  const box = $("#ld-similar"); if (box) { box.hidden = true; box.innerHTML = ""; }
  if (er) er.hidden = true;
  const dc = $("#lang-declare"); if (dc) dc.hidden = true;
  // La langue est DÉJÀ créée. On enchaîne sur l'amorce sonore : enregistrer quelques
  // mots de base (≥ AMORCE_MIN visé). L'utilisateur peut s'arrêter quand il veut — la
  // langue reste créée et le peu enregistré est conservé.
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
  // Le bouton « Terminer » se met en avant dès le minimum atteint.
  const fin = $("#amorce-finish");
  if (fin) fin.classList.toggle("btn--go", _amorceDone >= AMORCE_MIN);
  _amResetRecUiOnly();
}
function _amResetRecUiOnly() {
  const v = $("#amorce-validate"); if (v) v.disabled = !_amBlob;
}
async function amorceRecToggle() {
  if (_amRec && _amRec.state === "recording") { amorceStopRec(); return; }
  if (!window.isSecureContext) {
    toast("L'enregistrement audio exige HTTPS ou localhost (sécurité du navigateur). ", "warn");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast("Ce navigateur ne supporte pas l'enregistrement audio. Essaie Chrome ou Firefox à jour.", "warn");
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
  if (_amorceDone < AMORCE_MIN) {
    const msg = ti("amorce.finish.confirm", { n: _amorceDone, min: AMORCE_MIN, lang: _amorceLang.nom });
    if (!window.confirm(msg)) return;
  }
  // La nouvelle langue devient la langue courante ; on recharge pour tout reconstruire
  // proprement (corpus, clavier, Explorer) dans cette langue, et on vise l'accueil.
  setCurrentLangId(_amorceLang.id);
  try { history.replaceState(null, "", "#/accueil"); } catch (e) { /* ok */ }
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
  await DB.put(rec);
  markDoneText(rec.source_text);
  kickReconcile();
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
  const h = $("#work-help");
  if (h) h.innerHTML = isT ? t("work.help.transcribe") : t("work.help.translate");
  const la = $("#lbl-audio"); if (la) la.textContent = isT ? t("work.audio.transcribe") : t("work.audio.translate");
  const pl = $("#prop-cat-label"); if (pl) pl.textContent = isT ? t("work.propcat.transcribe") : t("work.propcat.translate");
  const tl = $("#lbl-target"); if (tl) tl.textContent = isT ? t("work.lbltarget.transcribe") : t("work.lbltarget.translate");
  const tp = $("#tab-traduire"); if (tp) tp.classList.toggle("is-active", !isT);
  const tt = $("#tab-transcrire"); if (tt) tt.classList.toggle("is-active", isT);
  const te = $("#tab-explorer"); if (te) te.classList.remove("is-active");
  updateGate();
}
function enterWork(act) {
  if (!requireProfile(act === "transcribe"
    ? "Crée ton profil pour enregistrer des prononciations."
    : "Crée ton profil pour proposer des traductions.")) return;
  if (isKbOpen()) hideKeyboard();
  setActivity(act);
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
}
function enterExplore() {
  if (!requireProfile("Crée ton profil pour explorer la bibliothèque de la communauté.")) return;
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
  { sel: ".brand", title: "LANGA, en deux mots", text: "Cette application rassemble les mots et les voix de nos langues pour en bâtir des dictionnaires, des claviers et des intelligences artificielles. Touche ce logo ou ce nom à tout moment pour revenir à l'accueil et ses trois portes : Traduire, Transcrire, Explorer",
    en: { title: "LANGA in a nutshell", text: "This app gathers the words and voices of our languages to build dictionaries, keyboards and artificial intelligences from them. Tap this logo or name at any time to go back to the home screen and its three doors: Translate, Transcribe, Explore" } },
];
// Barre d'outils du header, disponible sur toutes les pages.
const TOUR_TOOLS = [
  { sel: "#net", title: "Tes voyants d'état", text: "Ici se lisent ta connexion et le lien avec la base, puis le nombre de contributions déjà rassemblées par toute la communauté. Hors connexion rien n'est perdu : tout est gardé sur l'appareil et repart tout seul dès que le réseau revient",
    en: { title: "Your status lights", text: "Here you can read your connection and the link to the database, then the number of contributions already gathered by the whole community. Offline nothing is lost: everything is kept on the device and leaves on its own as soon as the network is back" } },
  { sel: "#app-ver", title: "Ta version", text: "Le numéro de la version que tu utilises. L'application se met à jour d'elle-même : quand une version plus récente existe, une bannière te prévient et un seul bouton l'installe, sans aucune manœuvre technique de ta part",
    en: { title: "Your version", text: "The number of the version you're using. The app updates itself: when a newer version exists, a banner warns you and a single button installs it, with no technical step on your part" } },
  { sel: "#home-link", title: "Revenir à l'accueil", text: "Te ramène à l'écran d'accueil, celui qui présente les trois portes : Traduire, Transcrire et Explorer. Pratique pour changer d'activité d'un seul geste, depuis n'importe quelle page. Le logo et le nom, en haut comme en bas, font la même chose",
    en: { title: "Back to home", text: "Takes you back to the home screen, the one that presents the three doors: Translate, Transcribe and Explore. Handy to switch activity in one move, from any page. The logo and the name, at the top as at the bottom, do the same thing" } },
  { sel: "#lang-chip", title: "Ta langue", text: "Indique la langue dans laquelle tu contribues, et permet d'en changer à tout moment. LANGA est communautaire : si ta langue n'existe pas encore, tu peux la déclarer d'ici, et elle deviendra aussitôt disponible pour tous ceux qui la parlent",
    en: { title: "Your language", text: "Shows the language you're contributing in, and lets you change it at any time. LANGA is community-driven: if your language doesn't exist yet, you can declare it from here, and it becomes immediately available to everyone who speaks it" } },
  { sel: "#about-link", title: "Découvrir le projet", text: "Ouvre la page qui raconte l'ambition de LANGA, pourquoi ta langue mérite d'exister dans le numérique et les trois manières d'y prendre part. C'est la page idéale à montrer à quelqu'un que tu veux convaincre de participer",
    en: { title: "Discover the project", text: "Opens the page that tells LANGA's ambition, why your language deserves to exist in the digital world and the three ways to take part. It's the ideal page to show someone you want to convince to join" } },
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
    { sel: "#btn-save", title: "Garder ta contribution", text: "Ta réponse est d'abord rangée en sécurité sur ton appareil, même sans réseau. Rien ne part encore : tu peux enchaîner tranquillement plusieurs items, puis tout transmettre d'un coup un peu plus tard",
      en: { title: "Keep your contribution", text: "Your answer is first stored safely on your device, even without network. Nothing leaves yet: you can calmly go through several items, then send them all at once a little later" } },
    { sel: ".send-row", title: "Transmettre à la base", text: "L'envoi regroupe tout ce qui attend. Il est conçu pour ne rien perdre : chaque contribution est renvoyée jusqu'à ce que la base confirme l'avoir bien reçue, même quand le réseau est capricieux",
      en: { title: "Send to the database", text: "Sending gathers everything that's waiting. It's designed to lose nothing: each contribution is resent until the database confirms it received it, even when the network is capricious" } },
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
    { sel: ".about-head", title: "La page qui raconte le projet", text: "Un espace à part pour présenter LANGA : d'où vient son nom, quelle ambition le porte et comment n'importe qui peut y prendre part. C'est la page à partager pour donner à d'autres l'envie de contribuer",
      en: { title: "The page that tells the project", text: "A dedicated space to present LANGA: where its name comes from, what ambition drives it and how anyone can take part. It's the page to share to give others the urge to contribute" } },
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
    { sel: "#lang-declare-btn", title: "Déclarer ta langue", text: "Si ta langue n'apparaît pas encore dans la liste, ce bouton ouvre un court formulaire pour la créer. Elle devient aussitôt disponible pour toi et pour toute personne qui la parle : LANGA est fait pour accueillir toutes nos langues",
      en: { title: "Declare your language", text: "If your language doesn't appear in the list yet, this button opens a short form to create it. It becomes immediately available to you and to anyone who speaks it: LANGA is made to welcome all our languages" } },
    { sel: "#lang-grid", title: "Choisir ta langue", text: "Chaque carte est une langue déjà présente : touche-la pour contribuer dans cette langue. Le ngiemboon a son clavier dédié avec les tons ; les autres s'écrivent avec le clavier habituel de ton téléphone en attendant le leur",
      en: { title: "Choose your language", text: "Each card is a language already present: tap it to contribute in that language. Ngiemboon has its dedicated keyboard with the tones; the others are written with your phone's usual keyboard while waiting for their own" } },
    { sel: "#lang-merge-panel", title: "Réunir les doublons", text: "Deux personnes ont parfois créé la même langue sous des écritures différentes. LANGA te le signale ici : tu peux confirmer une fusion qu'on te propose, accepter une ressemblance repérée automatiquement, ou choisir toi-même deux langues que tu sais identiques et proposer de les réunir. La fusion n'a lieu qu'avec l'accord des personnes concernées, et rien n'est perdu : les orthographes et les régions des deux sont conservées",
      en: { title: "Merge duplicates", text: "Two people sometimes created the same language under different spellings. LANGA flags it for you here: you can confirm a merge proposed to you, accept a resemblance spotted automatically, or pick two languages yourself that you know are identical and propose to merge them. The merge only happens with the agreement of the people concerned, and nothing is lost: the spellings and regions of both are kept" } },
    { sel: "#ld-nom", title: "Le nom de la langue", text: "Écris le nom sous lequel ta langue est connue. Pendant que tu tapes, LANGA compare avec les langues déjà déclarées pour t'éviter de créer un doublon sous une orthographe un peu différente",
      en: { title: "The language name", text: "Write the name your language is known by. As you type, LANGA compares with the languages already declared to save you from creating a duplicate under a slightly different spelling" } },
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
  if (!_tourSteps.length) { toast("Rien à guider sur cette page pour le moment.", "warn"); return; }
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
let _exploreEntries = [];
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
/** Partage une entrée (carte texte) : navigator.share si dispo, sinon presse-papiers. */
async function shareEntry(src, tgt) {
  const L = currentLang();
  const appUrl = location.origin + location.pathname;
  const text = shareCardText({ source_text: src, target_text: tgt }, L.nom, appUrl);
  try {
    if (navigator.share) { await navigator.share({ title: shareTitle(L.nom), text }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; /* sinon : on tente le presse-papiers */ }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast("Carte copiée, colle-la où tu veux !", "ok");
      return;
    }
  } catch (e) { /* dernier repli ci-dessous */ }
  toast("Partage indisponible sur cet appareil.", "warn");
}

/** Télécharge le dictionnaire de la LANGUE COURANTE (entrées visibles) en CSV ou JSON. */
function downloadDict(fmt) {
  const lid = getCurrentLangId();
  const entries = _exploreEntries || [];
  let content, mime;
  if (fmt === "json") {
    content = entriesToJSON(entries, { langue: lid, nom: currentLang().nom, exporte_par: "LANGA" });
    mime = "application/json";
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
    toast("Export impossible sur cet appareil.", "err");
  }
}

async function loadLibrary() {
  initExploreOnce();
  const status = $("#explore-status"), list = $("#explore-list");
  if (status) status.textContent = t("exp.loading");
  if (list) list.innerHTML = "";
  try {
    const data = await browseLibrary({ limit: 500 });
    // Explorer est scopé sur la LANGUE COURANTE, et on ignore les entrées SANS AUCUN
    // contenu (ni mot source, ni traduction, ni audio jouable) : de telles entrées
    // dégénérées (POST malformé/ancien) créaient un groupe « — » vide, trompeur et
    // sans bouton audio/traduction (BUG-U-mrmae78s-7670).
    // Langue courante et langue de chaque entrée résolues vers leur CANONIQUE : les
    // contributions d'une langue fusionnée apparaissent sous celle qui l'a absorbée.
    const lid = canonLangId(getCurrentLangId());
    _exploreEntries = (((data && data.entries) || []))
      .filter((e) => canonLangId(entryLang(e)) === lid)
      .filter((e) => (e.source_text && e.source_text.trim()) ||
                     (e.target_text && e.target_text.trim()) || isPlayable(e.audio_url));
    // Le clavier prédictif APPREND des contributions réelles (mots + fréquences).
    if (predict && lid === "nge") predict.learnFromEntries(_exploreEntries, lid);
    populateExploreFilters();
    renderExplore();
  } catch (e) {
    _exploreEntries = [];
    if (status) status.textContent = "";
    if (list) list.innerHTML =
      '<div class="explore-empty">La bibliothèque n\'a pas pu être chargée.<br>Vérifie ta connexion, puis rouvre l\'onglet Explorer.</div>';
  }
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
  refreshEnhancedSelects();               // les filtres sont déjà habillés (auto) → resync
}
/** Clé de normalisation (casse/espaces ignorés) pour regrouper un même mot. */
function _normKey(s) { return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " "); }
/** Regroupe les contributions par (sens + texte source normalisé) = un headword. */
function buildGroups(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.direction + "::" + _normKey(e.source_text);
    let g = map.get(key);
    if (!g) { g = { key, direction: e.direction, source_text: e.source_text || "", entries: [], _srcCount: {} }; map.set(key, g); }
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
  // Villages connus à position fixe ; TOUS les autres (quartiers…) agrégés en un
  // seul nœud « Autres » à une place réservée → aucun chevauchement possible.
  const known = items.filter(([v]) => VILLAGE_POS[v]);
  const autres = items.filter(([v]) => !VILLAGE_POS[v]).reduce((s, x) => s + x[1], 0);
  const raw = known.map(([v, c]) => [v, c, VILLAGE_POS[v]]);
  if (autres > 0) raw.push([t("exp.vmap.others"), autres, [16, 22]]);
  const max = Math.max.apply(null, raw.map((x) => x[1]));
  const nodes = raw.map(([v, c, pos]) => ({ v: v, c: c, x: pos[0], y: pos[1], mine: v === mine }));
  const cx = (VILLAGE_POS["Bangang"] || [50, 58])[0], cy = (VILLAGE_POS["Bangang"] || [50, 58])[1];
  const links = nodes.map((n) =>
    `<line x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" style="stroke:var(--gold)" stroke-opacity="0.16" stroke-width="0.45"/>`
  ).join("");
  const diamonds = nodes.map((n) => {
    const r = (2.6 + 4.4 * Math.sqrt(n.c / max)).toFixed(2);
    const fill = n.mine ? "var(--gold)" : "var(--cyan)";
    const stroke = n.mine ? "var(--gold)" : "var(--green)";
    return `<g transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})">
      <rect x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" rx="0.7" transform="rotate(45)"
        style="fill:${fill};stroke:${stroke}" fill-opacity="${n.mine ? 0.92 : 0.72}" stroke-width="0.5"/>
      <text x="0" y="1" text-anchor="middle" font-size="2.7" font-weight="700" style="fill:#06121a">${n.c}</text>
      <text x="0" y="${(+r + 3.8).toFixed(1)}" text-anchor="middle" font-size="3" font-weight="600" style="fill:var(--text)">${escapeHtml(n.v)}</text>
    </g>`;
  }).join("");
  host.innerHTML = `<div class="vmap-head">${t("exp.vmap.head")}</div>
    <div class="vmap-sub">${t("exp.vmap.sub")}${mine ? t("exp.vmap.sub.mine") : ""}.</div>
    <svg viewBox="0 0 100 82" class="vmap-svg" role="img" aria-label="${t("exp.vmap.aria")}">
      ${links}${diamonds}
    </svg>`;
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
    if (fd && e.direction !== fd) return false;
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
  const visKeys = new Set(_exploreEntries.filter(match).map((e) => e.direction + "::" + _normKey(e.source_text)));
  const groups = _exploreGroups.filter((g) => visKeys.has(g.key))
    .sort((a, b) => b.entries.length - a.entries.length || _normKey(a.source_text).localeCompare(_normKey(b.source_text)));
  if (status) status.textContent = ti(groups.length > 1 ? "exp.count.many" : "exp.count.one", { n: groups.length }) +
    (groups.length !== _exploreGroups.length ? ti("exp.count.of", { t: _exploreGroups.length }) : "");
  if (groups.length === 0) {
    list.innerHTML = `<div class="explore-empty">${_exploreEntries.length === 0
      ? ti("exp.empty.lang", { lang: escapeHtml(currentLang().nom) })
      : t("exp.empty.search")}</div>`;
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
        triedBlob = true; setStatus("Chargement de l'audio…");
        try {
          const r = await fetch(src, { mode: "cors" });
          if (r.ok) { const b = await r.blob(); audio.src = URL.createObjectURL(b); audio.load(); setStatus(""); return; }
        } catch (e) { /* échec */ }
      }
      setStatus("Lecture indisponible ici, réessaie plus tard.");
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
  if (setStatus) setStatus("Chargement de l'audio…");
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
  if (setStatus) setStatus("Lecture indisponible pour le moment.");
}
function dirLabel(d) {
  const code = getCurrentLangId().slice(0, 3).toUpperCase();
  return d === "nge2fr" ? `${code} → FR` : `FR → ${code}`;
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
    <div class="entry-actions">
      <button type="button" class="entry-improve" data-id="${escapeHtml(e.id)}" data-orig="${escapeHtml(e.target_text || "")}">${t("exp.improve")}</button>
      <button type="button" class="entry-share" data-src="${escapeHtml(e.source_text || "")}" data-tgt="${escapeHtml(e.target_text || "")}" title="${t("exp.share.title")}" aria-label="${t("exp.share.aria")}">${t("exp.share")}</button>
    </div>
    <div class="entry-corr" hidden></div>
  </article>`;
}

// --- Corrections communautaires + consensus (par entrée) -------------------
function onExploreClick(e) {
  const back = e.target.closest(".grp-back");
  if (back) { renderExplore(); return; }
  const imp = e.target.closest(".entry-improve");
  if (imp) { toggleCorrections(imp.closest(".entry"), imp.dataset.id, imp.dataset.orig); return; }
  const shr = e.target.closest(".entry-share");
  if (shr) { shareEntry(shr.dataset.src, shr.dataset.tgt); return; }
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
  panel.innerHTML = '<div class="corr-loading">Chargement des corrections…</div>';
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
          <button type="button" class="corr-vote" data-cible="${escapeHtml(c.id)}">👍 ${c.votes}</button>
        </div>`).join("")
    : "";
  const audioHtml = audioAlts.length
    ? `<div class="corr-sub">${t("corr.sub.audio")}</div>` + audioAlts.map((s) =>
        `<div class="corr-cand">
          <span class="corr-cand-txt">${playableAudio(s.audio, s.duree_ms || s.audio_duree_ms)}${s.credit ? ` <span class="corr-credit">· ${escapeHtml(s.credit)}</span>` : ""}</span>
          <button type="button" class="corr-vote" data-cible="${escapeHtml(s.id)}">👍 ${s.votes}</button>
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
  btn.disabled = true;
  try {
    await postVote({ id_cible: btn.dataset.cible, device_id: deviceId(), valeur: 1 });
    await reloadCorrections(btn.closest(".entry"));
  } catch (e) { btn.disabled = false; toast("Vote non enregistré (connexion ?).", "warn"); }
}
async function onProposeSubmit(btn) {
  const panel = btn.closest(".entry-corr");
  const sel = panel.querySelector(".corr-form select");   // masqué (sr-only) → par balise
  const type = (sel && sel.value) || "texte";
  if (!profileComplete()) { toast("Renseigne ton profil pour proposer.", "warn"); openProfile(true); return; }
  const c = loadContributeur();
  const base = {
    id_contribution: btn.dataset.entry, type,
    credit_display: c.credit_display || "", device_id: deviceId(),
    client_id: (crypto.randomUUID && crypto.randomUUID()) || "s-" + Date.now(),
  };
  let payload;
  if (type === "audio") {
    if (!panel._corrBlob) { toast("Enregistre d'abord ta prononciation.", "warn"); return; }
    payload = Object.assign(base, {
      audio_base64: await blobToBase64Corr(panel._corrBlob),
      audio: { present: true, format: panel._corrBlob.type || "audio/webm", duree_ms: panel._corrDur || 0 },
    });
  } else {
    const inp = panel.querySelector("[data-role='corr-text']");
    const texte = nfc(inp ? inp.value.trim() : "");
    if (!texte) { toast("Écris ta proposition.", "warn"); return; }
    payload = Object.assign(base, { texte });
  }
  btn.disabled = true;
  try {
    await postSuggestion(payload);
    panel._corrBlob = null; panel._corrDur = 0;
    await reloadCorrections(panel.closest(".entry"));
    toast("Proposition envoyée. Merci !", "ok");
  } catch (e) { btn.disabled = false; toast("Envoi impossible (connexion ?).", "warn"); }
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
      btn.classList.remove("is-recording"); btn.textContent = "🎙 Refaire";
      const t = panel.querySelector("[data-role='corr-timer']"); if (t) t.hidden = true;
      clearInterval(_corrTimerInt);
      const prev = panel.querySelector("[data-role='corr-preview']");
      if (prev) mountLocalAudioPlayer(prev, URL.createObjectURL(blob), panel._corrDur || 0);
    };
    _corrStartTs = Date.now();
    _corrRec.start();
    btn.classList.add("is-recording"); btn.textContent = "⏹ Arrêter";
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
      ? (disp ? `Apparaîtra comme : « ${disp} »` : "Renseigne ton nom/prénom pour l'aperçu")
      : "";
  }
}

/** Thème clair/sombre — clair par défaut ; choix mémorisé et appliqué dès le
    <head> (le bouton ne fait qu'inverser). */
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("ng-theme", mode); } catch (e) { /* stockage indispo */ }
  const btn = $("#theme-toggle");
  if (btn) {
    // L'icône (soleil+lune) est statique = « basculer le thème » ; on n'ajuste que le libellé.
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
function itemHtml(it, confirmed) {
  const fr2nge = it.direction === "fr2nge";
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
      ? `<span class="badge badge--sent" title="Confirmée présente dans la base">✓ envoyée</span>`
      : `<span class="badge badge--local" title="Pas encore confirmée dans la base">⟳ en attente</span>` +
        `<button class="mini" data-resend="${it.client_id}" title="Renvoyer maintenant">↻</button>`) +
    `<button class="mini" data-del="${it.client_id}" title="Supprimer">✕</button>` +
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
      li.innerHTML = itemHtml(it, confirmed);
      ul.appendChild(li);
    }
  };
  fill("#list-pending", pending, false);
  fill("#list-sent", sent, true);

  document.querySelectorAll("[data-resend]").forEach((b) =>
    b.addEventListener("click", () => { kickReconcile(true); toast("Renvoi en cours…", "ok"); })
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
    setStatus("Hors connexion, renvoi automatique dès le retour du réseau.");
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
      toast(modeGoogle() ? "Tout est confirmé dans ta Drive ✅"
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
  $("#net").textContent = on ? "en ligne" : "hors ligne";
  $("#net").className = "chip " + (on ? "chip--on" : "chip--off");
  let srv = false;
  try { srv = await checkServer(); } catch (e) { srv = false; }
  const g = modeGoogle();
  $("#srv").textContent = g
    ? (srv ? "Drive : prêt" : "hors ligne")
    : (srv ? "serveur : connecté" : "serveur : hors d'atteinte");
  $("#srv").className = "chip " + (srv ? "chip--on" : "chip--off");
  $("#srv-stats").textContent = "";
  if (srv && !g) {
    try {
      const st = await serverStats();
      const n = st && st.stores && st.stores[0] ? st.stores[0].count : 0;
      $("#srv-stats").textContent = n + " enregistrement(s) · " + (st && st.stores ? st.stores.length : 0) + " copies";
    } catch (e) { /* ignore */ }
  }
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
const PRESENT_URL = "https://brice-kengni-zanguim.github.io/langa/app/collecte/";

// Barres de partage du site (réseaux) disséminées : accueil, À propos, footer, présentation.
function mountShareBars() {
  // Paramètre ajouté au lien PARTAGÉ : certains réseaux (WhatsApp, Telegram) gardent
  // en cache le tout premier aperçu vu d'une URL. Si le lien nu a été partagé avant que
  // l'image d'aperçu existe, ils affichent « sans image » pour toujours. En partageant
  // une URL légèrement distincte (…?s=1), le réseau la voit comme neuve et récupère
  // l'aperçu à jour (avec l'image). Sans effet pour l'utilisateur : même application.
  const shareUrl = PRESENT_URL + "?s=1";
  const opts = {
    url: shareUrl,
    text: t("share.text"),
    title: "LANGA",
    toast: toast,
    nativeLabel: t("share.native"),
    copyLabel: t("share.copy"),
    copiedMsg: t("share.copied"),
    igMsg: t("share.ig"),
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
  const diamond = (cx, cy, r) => { g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); };
  g.save();
  for (let ty = 0; ty < H + 132; ty += 132) for (let tx = 0; tx < W + 132; tx += 132) {
    const cx = tx + 66, cy = ty + 66;
    g.lineWidth = 1.4; g.globalAlpha = dark ? 0.22 : 0.30; g.strokeStyle = gold; diamond(cx, cy, 62); g.stroke();
    g.lineWidth = 1.2; g.globalAlpha = dark ? 0.19 : 0.26; g.strokeStyle = cyan; diamond(cx, cy, 34); g.stroke();
    g.lineWidth = 0.9; g.globalAlpha = dark ? 0.14 : 0.20; g.strokeStyle = gold; diamond(cx, cy, 16); g.stroke();
  }
  g.restore(); g.globalAlpha = 1;
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
  g.fillText("LANGA", W / 2, 700);
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
    const qr = await loadImage("../flyer/qr.png");
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
  catch (e) { toast("Téléchargement impossible sur cet appareil.", "warn"); return; }
  try {
    if (kind === "pdf") {
      downloadBlob(canvasToPdfBlob(cv), "langa-presentation.pdf");
    } else {
      await new Promise((res) => cv.toBlob((b) => { downloadBlob(b, "langa-presentation.png"); res(); }, "image/png"));
    }
    toast("Présentation téléchargée ✓", "ok");
  } catch (e) {
    toast("Téléchargement impossible sur cet appareil.", "warn");
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
async function checkForUpdate() {
  const dep = await fetchDeployedVersion();
  if (!dep || _verNum(dep) <= _verNum(APP_VERSION)) {   // rien de plus récent → on masque
    _hideBanner();
    localStorage.removeItem("updateDismissed");          // repart propre pour la prochaine fois
    return;
  }
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
    toast("Application à jour (" + APP_VERSION + ") ✓");
    return;
  }
  if (verdict === "giveup") {
    sessionStorage.removeItem("pendingUpdate");
    toast("Mise à jour automatique impossible, recharge la page (Ctrl+Maj+R).", "warn");
    return;
  }
  // "retry" : nouvelle tentative bornée
  sessionStorage.setItem("pendingUpdate", JSON.stringify({ to: pend.to, tries: (pend.tries || 0) + 1 }));
  _deployedVer = pend.to;
  toast("Finalisation de la mise à jour…");
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

// --- Clavier prédictif ngiemboon : barre de suggestions de MOTS RÉELS ---------
// Le moteur (predict.js) est amorcé par le lexique validé et APPREND en plus des
// contributions déjà collectées. La barre n'apparaît que pour le ngiemboon (seule
// langue à lexique dédié) et seulement s'il y a quelque chose à proposer.
function initPredict() {
  if (!predict) predict = new PredictNgiemboon();
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

/** Le clavier prédictif est-il pertinent pour la langue courante ? (lexique = nge). */
function predictActive() {
  return !!predict && getCurrentLangId() === "nge" && !!(keyboard && keyboard.target);
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
  sel.innerHTML = (CONFIG.INDICATIFS || []).map((x) =>
    `<option value="${escapeHtml(x.d)}">${x.f} ${escapeHtml(x.p)} (${escapeHtml(x.d)})</option>`
  ).join("");
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
}

/** Remplit les champs du profil depuis le stockage (aussi utilisé pour annuler). */
function fillProfileFields() {
  const c = loadContributeur();
  $("#c-nom").value = c.nom || "";
  $("#c-prenom").value = c.prenom || "";
  $("#c-role").value = c.role || "";
  $("#c-email").value = c.email || "";
  $("#c-indicatif").value = c.indicatif || CONFIG.INDICATIF_DEFAUT || "";
  $("#c-tel").value = c.telephone || "";
  $("#c-consent").checked = !!c.consentement;
  $("#c-village").value = c.village || "";
  $("#c-credit-on").checked = !!(c.creditMode && c.creditMode !== "none");
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
  $("#btn-save").addEventListener("click", saveContribution);
  $("#btn-send").addEventListener("click", send);
  const rs = $("#btn-resend"); if (rs) rs.addEventListener("click", () => { kickReconcile(); toast("Renvoi en cours…", "ok"); });
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
  $("#btn-open-profile").addEventListener("click", () => openProfile(true));
  // Cartes de l'accueil
  document.querySelectorAll(".hub-card").forEach((card) =>
    card.addEventListener("click", () => {
      const go = card.dataset.go;
      if (go === "explore") enterExplore(); else enterWork(go);
    })
  );
  // Onglets de navigation permanents
  const nt = $("#tab-traduire"); if (nt) nt.addEventListener("click", () => enterWork("translate"));
  const nx = $("#tab-transcrire"); if (nx) nx.addEventListener("click", () => enterWork("transcribe"));
  const ne = $("#tab-explorer"); if (ne) ne.addEventListener("click", enterExplore);
  const eCsv = $("#export-csv"); if (eCsv) eCsv.addEventListener("click", () => downloadDict("csv"));
  const eJson = $("#export-json"); if (eJson) eJson.addEventListener("click", () => downloadDict("json"));
  // Page « À propos » (vraie vue de l'app, avec header/footer/fond partagés)
  const aboutLink = $("#about-link"); if (aboutLink) aboutLink.addEventListener("click", openAbout);
  const aboutBack = $("#about-back"); if (aboutBack) aboutBack.addEventListener("click", () => showView(_aboutReturn || "hub"));
  const bugsLink = $("#bugs-link"); if (bugsLink) bugsLink.addEventListener("click", openBugs);
  const bugsBack = $("#bugs-back"); if (bugsBack) bugsBack.addEventListener("click", () => showView(_bugsReturn || "hub"));
  const bugSend = $("#bug-send"); if (bugSend) bugSend.addEventListener("click", submitBug);
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
  // Bouton « Accueil » du header → écran d'accueil (hub des 3 portes).
  const homeLink = $("#home-link"); if (homeLink) homeLink.addEventListener("click", goHome);
  // Bascule de la langue d'INTERFACE (FR ⇄ EN), distincte de la langue de contenu.
  const uiToggle = $("#ui-lang-toggle");
  if (uiToggle) uiToggle.addEventListener("click", () => {
    // Bascule de langue d'INTERFACE : on recharge pour que TOUT se reconstruise
    // dans la nouvelle langue (y compris les <select> habillés, la visite guidée, etc.).
    setUiLang(getUiLang() === "en" ? "fr" : "en");
    location.reload();
  });
  // Sélecteur de langue (header) + déclaration d'une nouvelle langue.
  const langChip = $("#lang-chip"); if (langChip) langChip.addEventListener("click", openLangChoice);
  const ldSubmit = $("#ld-submit"); if (ldSubmit) ldSubmit.addEventListener("click", submitDeclareLang);
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
    const dc = $("#lang-declare"); if (dc) dc.hidden = true;
    const er = $("#ld-error"); if (er) er.hidden = true;
  });
  // Logo + nom (header ET footer) = raccourci cliquable vers l'accueil (souris + clavier).
  [$("#brand-home"), $("#foot-home")].forEach((el) => {
    if (!el) return;
    el.addEventListener("click", goHome);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); goHome(); }
    });
  });
  // Mode présentation (plein écran)
  const presentOpen = $("#present-open"); if (presentOpen) presentOpen.addEventListener("click", openPresent);
  const presentClose = $("#present-close"); if (presentClose) presentClose.addEventListener("click", closePresent);
  const dlPng = $("#present-dl-png"); if (dlPng) dlPng.addEventListener("click", () => downloadPresent("png"));
  const dlPdf = $("#present-dl-pdf"); if (dlPdf) dlPdf.addEventListener("click", () => downloadPresent("pdf"));
  // Routeur : le bouton Précédent/Suivant du navigateur rejoue la vue correspondante.
  window.addEventListener("popstate", onHistoryNav);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#present") && !$("#present").hidden) closePresent();
  });
  // Si l'utilisateur quitte le plein écran (Échap système), on referme aussi l'overlay.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && $("#present") && !$("#present").hidden) $("#present").hidden = true;
  });
}

async function main() {
  initTheme();
  const ver = $("#app-ver");
  if (ver) ver.textContent = APP_VERSION;
  initContributeur();
  initKeyboard();
  initKeyboardReveal();
  initPropCategories();
  applyI18n();       // langue d'INTERFACE (FR/EN) sur tout le DOM statique marqué —
                     // AVANT d'habiller les <select> pour qu'ils prennent la bonne langue
  initSelectAutoEnhance();                // habille TOUS les <select> (auto, présents + futurs)
  initEvents();
  initTour();
  initTrim();        // outil de découpe d'un enregistrement (garder une portion)
  applyLanguage();   // applique la langue courante (libellés + clavier dédié/défaut) + sens
  mountShareBars();  // boutons de partage du site (réseaux) sur les emplacements dédiés
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
  if (!hasChosenLang()) {
    openLangChoice();
  } else {
    const route = hashToRoute();   // ex. #/apropos, #/explorer → on restaure cette page
    if (route) routeTo(route); else enterHub();
  }
  _replayingHistory = false;
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
