// Synchronisation des contributions.
// Deux modes selon config.js :
//   ENDPOINT vide     → serveur local Python (POST JSON, sauvegarde 4 copies).
//   ENDPOINT = Google → Google Apps Script (POST text/plain → Sheet + Drive).
import { DB } from "./db.js";
import { CONFIG } from "./config.js";

export function endpoint() {
  const url = (CONFIG.ENDPOINT || localStorage.getItem("serveurUrl") || "").trim();
  return url.replace(/\/+$/, "");
}
function isGoogle() {
  return endpoint().includes("script.google.com");
}
export function modeGoogle() { return isGoogle(); }

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function toPayload(rec) {
  const p = {
    client_id: rec.client_id,
    direction: rec.direction,
    source_lang: rec.source_lang,
    target_lang: rec.target_lang,
    source_text: rec.source_text,
    target_text: rec.target_text,
    domaine: rec.domaine || "",
    note: rec.note || "",
    contributeur: rec.contributeur || {},
    consentement: !!rec.consentement,
    proposition_id: rec.proposition_id || "",
    proposition_cat: rec.proposition_cat || "",
    device_id: rec.device_id,
    created_at: rec.created_at,
    audio: rec.audioMeta || { present: false },
  };
  if (rec.audioBlob) {
    p.audio_base64 = await blobToBase64(rec.audioBlob);
    p.audio = { present: true, format: rec.audioBlob.type || "audio/webm",
      duree_ms: rec.audioMeta ? rec.audioMeta.duree_ms : null };
  }
  return p;
}

export async function checkServer() {
  if (isGoogle()) return navigator.onLine; // pas de ping fiable cross-origin
  if (!endpoint()) {
    // serveur local même origine
    try { const r = await fetch("/api/health", { cache: "no-store" }); return r.ok; }
    catch (e) { return false; }
  }
  try { const r = await fetch(endpoint() + "/api/health", { cache: "no-store" }); return r.ok; }
  catch (e) { return false; }
}

export async function serverStats() {
  if (isGoogle()) return null; // les stats vivent dans la Google Sheet
  const base = endpoint();
  const r = await fetch((base || "") + "/api/stats", { cache: "no-store" });
  if (!r.ok) throw new Error("stats indisponibles");
  return r.json();
}

/**
 * Lit la bibliothèque communautaire (données ASSAINIES, aucune donnée perso).
 * Google → …/exec?action=browse ; local → /api/browse. Retourne {ok,total,entries}.
 */
export async function browseLibrary(opts = {}) {
  const limit = opts.limit || 500, offset = opts.offset || 0;
  const dev = opts.device_id ? "&device_id=" + encodeURIComponent(opts.device_id) : "";
  let url;
  if (isGoogle()) {
    url = `${endpoint()}?action=browse&limit=${limit}&offset=${offset}${dev}`;
  } else {
    const base = endpoint();
    url = `${base || ""}/api/browse?limit=${limit}&offset=${offset}${dev}`;
  }
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("bibliothèque indisponible (" + r.status + ")");
  return r.json();
}

/**
 * Récupère un enregistrement Drive via le script Google (seul à pouvoir lire Drive),
 * en base64, pour le jouer LOCALEMENT dans le lecteur sur-mesure. Retourne
 * {ok, mime, b64}. N'a de sens qu'en mode Google (côté local, l'audio est servi
 * directement par /audio/ et se lit sans détour).
 */
export async function fetchDriveAudio(fileId) {
  if (!fileId || !isGoogle()) return { ok: false };
  const url = `${endpoint()}?action=audio&id=${encodeURIComponent(fileId)}`;
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error("audio indisponible (" + r.status + ")");
  return r.json();
}

/**
 * VÉRITÉ DE RÉFÉRENCE pour la synchro : demande à la base distante la liste des
 * `client_id` DÉJÀ ENREGISTRÉS pour CE device. Permet de cocher ✅ ce qui est
 * réellement arrivé (au lieu de se fier à la réponse d'un POST, peu fiable avec
 * Apps Script à cause des redirections). Retourne un Set de client_id, ou
 * `null` si l'endpoint n'existe pas encore (ancien backend non redéployé).
 */
export async function confirmedIds(deviceId) {
  if (!deviceId) return new Set();
  const base = endpoint();
  const url = isGoogle()
    ? `${base}?action=confirm&device_id=${encodeURIComponent(deviceId)}`
    : `${base || ""}/api/confirm?device_id=${encodeURIComponent(deviceId)}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || data.ok === false || !Array.isArray(data.ids)) return null;
    return new Set(data.ids.map(String));
  } catch (e) { return null; }
}

/** Suggestions + votes d'une entrée (données assainies). */
export async function fetchSuggestions(id) {
  const base = endpoint();
  const url = isGoogle()
    ? `${base}?action=suggestions&id=${encodeURIComponent(id)}`
    : `${base || ""}/api/suggestions?id=${encodeURIComponent(id)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("suggestions " + r.status);
  return r.json();
}
/** Registre des langues déclarées par la communauté (données publiques assainies).
    Renvoie un tableau de langues, ou null si indisponible (l'app garde alors la
    langue graine + le cache local). */
export async function fetchLanguages() {
  const base = endpoint();
  const url = isGoogle()
    ? `${base}?action=languages`
    : `${base || ""}/api/languages`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.languages) ? data.languages : null);
    return list;
  } catch (e) { return null; }
}
/** Déclare une nouvelle langue (visible ensuite par tous). Même canal que les contributions. */
export function declareLanguage(desc) {
  return postOp(Object.assign({ op: "declare_lang" }, desc));
}

/** Enregistre/actualise un PROFIL utilisateur dans la base, MÊME sans aucune
    contribution : tout profil complété doit apparaître dans l'Excel. Upsert par
    device_id, SANS incrémenter le compteur de contributions (op dédiée). */
export function declareUser(rec) {
  return postOp(Object.assign({ op: "declare_user" }, rec));
}

/** Propose la fusion (jumelage) de deux langues jugées identiques. La fusion n'est
    appliquée qu'après confirmation des déclarants concernés (gouvernance Phase C). */
export function proposeMerge(m) {
  return postOp(Object.assign({ op: "propose_merge" }, m));
}
/** Réponse d'un déclarant à une proposition de fusion : « oui » (même langue) ou « non ». */
export function respondMerge(r) {
  return postOp(Object.assign({ op: "respond_merge" }, r));
}
/** Propositions de fusion EN ATTENTE que CE device (déclarant concerné) doit confirmer.
    Renvoie [] si l'endpoint n'existe pas encore (ancien backend Google non redéployé). */
export async function mergesForDevice(deviceId) {
  if (!deviceId) return [];
  const base = endpoint();
  const url = isGoogle()
    ? `${base}?action=merges&device_id=${encodeURIComponent(deviceId)}`
    : `${base || ""}/api/merges?device_id=${encodeURIComponent(deviceId)}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    return (data && Array.isArray(data.merges)) ? data.merges : [];
  } catch (e) { return []; }
}

/** Notifications de CE device (les siennes + les globales). `since` = horodatage
    ms de la dernière lecture, pour compter les non-lues. Renvoie
    {ok, notifications:[…], unread, server_ts} ou null si l'endpoint n'existe pas
    encore (ancien backend Google non redéployé → l'app n'affiche simplement rien). */
export async function fetchNotifications(deviceId, since) {
  if (!deviceId) return null;
  const base = endpoint();
  const s = since ? "&since=" + encodeURIComponent(since) : "";
  const url = isGoogle()
    ? `${base}?action=notifications&device_id=${encodeURIComponent(deviceId)}${s}`
    : `${base || ""}/api/notifications?device_id=${encodeURIComponent(deviceId)}${s}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || data.ok === false || !Array.isArray(data.notifications)) return null;
    return data;
  } catch (e) { return null; }
}

/** Demandes ouvertes de traduction/transcription (« porte Demander »). Filtre par
    langue si fournie. Renvoie {ok, requests:[…]} ou null si l'endpoint n'existe pas
    encore (ancien backend Google non redéployé). */
export async function fetchRequests(langue, deviceId) {
  const base = endpoint();
  const l = langue ? "&langue=" + encodeURIComponent(langue) : "";
  const d = deviceId ? "&device_id=" + encodeURIComponent(deviceId) : "";
  const url = isGoogle()
    ? `${base}?action=requests${l}${d}`
    : `${base || ""}/api/requests?x=1${l}${d}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || data.ok === false || !Array.isArray(data.requests)) return null;
    return data;
  } catch (e) { return null; }
}
/** Publie une demande de traduction/transcription à la communauté. */
export function postRequest(r) { return postOp(Object.assign({ op: "request" }, r)); }
/** Répond à une demande : devient une contribution (alimente Explorer) + notifie le demandeur. */
export function postAnswer(a) { return postOp(Object.assign({ op: "answer_request" }, a)); }

/** POST d'une opération communautaire (suggest/vote), même canal que les contributions. */
async function postOp(payload) {
  const base = endpoint();
  if (isGoogle()) {
    const r = await fetch(base, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload), redirect: "follow",
    });
    try { return await r.json(); } catch (e) { return r.ok ? { ok: true } : { ok: false }; }
  }
  const r = await fetch((base || "") + "/api/op", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  try { return await r.json(); } catch (e) { return { ok: false }; }
}
export function postSuggestion(s) { return postOp(Object.assign({ op: "suggest" }, s)); }
export function postVote(v) { return postOp(Object.assign({ op: "vote" }, v)); }

/** Signale un bug (partagé). Même canal que les contributions ; idempotent par id. */
export function postBug(b) { return postOp(Object.assign({ op: "bug" }, b)); }

/** Traite/résout un bug (maintenance) : met à jour son statut. Jeton requis côté
    Google (seul le mainteneur peut résoudre) ; la mise à jour est ensuite renvoyée
    à tous via fetchBugs. */
export function postBugUpdate(u) { return postOp(Object.assign({ op: "bug_update" }, u)); }

/** Liste des bugs SIGNALÉS par les utilisateurs (partagés, assainis : pas de PII).
    Retourne {ok, bugs:[…]} ou null si l'endpoint n'existe pas (ancien backend). */
export async function fetchBugs() {
  const base = endpoint();
  const url = isGoogle() ? `${base}?action=bugs` : `${base || ""}/api/bugs`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !Array.isArray(data.bugs)) return null;
    return data.bugs;
  } catch (e) { return null; }
}

async function postOne(payload) {
  if (isGoogle()) {
    // text/plain = requête « simple » (pas de préflight CORS bloquant)
    const r = await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    try {
      const data = await r.json();
      return (data.reports && data.reports[0]) || { primary_ok: !!data.ok };
    } catch (e) {
      // Réponse illisible : on NE suppose PAS un succès (évite toute perte
      // silencieuse). On renvoie null → l'item reste en attente et sera réessayé ;
      // le backend dédoublonne par client_id, donc pas de doublon si l'envoi avait
      // en réalité abouti (le réessai récupère alors le server_id existant).
      return null;
    }
  }
  const base = endpoint();
  const r = await fetch((base || "") + "/api/contributions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  return (r.ok && data.reports && data.reports[0]) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Envoie UNE contribution avec réessais : les échecs d'envoi vers Apps Script
    sont souvent TRANSITOIRES (hoquet réseau mobile, réponse redirigée illisible,
    contention de verrou côté Google). On retente avec un délai croissant. Le
    backend dédoublonne par client_id → aucun risque de doublon si un envoi avait
    en fait réussi. Retourne le rapport si OK, sinon null après tous les essais. */
async function postOneWithRetry(payload, attempts = 3) {
  for (let a = 0; a < attempts; a++) {
    try {
      const report = await postOne(payload);
      if (report && report.primary_ok) return report;
    } catch (e) { /* réseau : on retente */ }
    if (a < attempts - 1) await sleep(600 * (a + 1) + Math.floor(Math.random() * 400));
  }
  return null;
}

/**
 * RÉCONCILIATION ROBUSTE — la vérité est la base distante, pas la réponse du POST.
 *
 * 1. On demande à la base la liste des `client_id` déjà présents pour ce device.
 * 2. On COCHE ✅ (statut « sent ») tout ce qui y est déjà — même si un précédent
 *    POST avait semblé « échouer » (réponse illisible) : la donnée est bien là.
 * 3. On (re)POSTe UNIQUEMENT ce qui manque encore (évite de renvoyer l'audio des
 *    items déjà confirmés). Le backend dédoublonne par `client_id` → aucun doublon.
 * 4. On RE-CONFIRME pour cocher ceux qui viennent d'arriver.
 *
 * Idempotent et sûr à répéter indéfiniment → la boucle de renvoi peut tourner
 * jusqu'à ce que `restant === 0`. Repli : si l'endpoint `confirm` n'existe pas
 * encore (ancien backend), on retombe sur la validation par réponse de POST.
 *
 * Retourne { confirmes, restant, envoyes, google, sansConfirm, echecsListe }.
 */
export async function reconcile(onProgress = () => {}) {
  const all = await DB.all();
  if (all.length === 0) return { confirmes: 0, restant: 0, envoyes: 0, google: isGoogle(), sansConfirm: false, echecsListe: [] };
  const deviceId = (all.find((x) => x.device_id) || {}).device_id || "";

  let confirmes = 0, envoyes = 0;
  const echecsListe = [];

  // 1+2) Confirmer d'abord ce qui est DÉJÀ dans la base distante.
  onProgress("Vérification de ce qui est déjà envoyé…");
  let remote = await confirmedIds(deviceId);
  const hasConfirm = remote !== null;
  if (hasConfirm) {
    for (const rec of all) {
      if (rec.status !== "sent" && remote.has(String(rec.client_id))) {
        await DB.markSent(rec.client_id, null); confirmes++;
      }
    }
  }

  // 3) (Re)poster uniquement ce qui manque encore — UNE seule fois par item
  //    (avec confirm, la redondance vient de la BOUCLE de réconciliation, pas de
  //    réessais lents par item : chaque cycle reste rapide, puis on vérifie).
  const toSend = (await DB.all()).filter((x) => x.status !== "sent");
  for (let i = 0; i < toSend.length; i++) {
    const rec = toSend[i];
    onProgress(`Envoi ${i + 1}/${toSend.length}…`);
    await DB.bumpAttempt(rec.client_id);
    let report = null;
    try { report = await postOne(await toPayload(rec)); }
    catch (e) { report = null; }
    if (report && report.primary_ok) {
      envoyes++;
      // Sans endpoint confirm (ancien backend), on se fie au rapport de POST.
      if (!hasConfirm) { await DB.markSent(rec.client_id, report.server_id); confirmes++; }
    } else if (!hasConfirm) {
      echecsListe.push(rec.source_text || rec.target_text || "(sans texte)");
    }
    if (i < toSend.length - 1) await sleep(150);   // léger souffle entre deux envois
  }

  // 4) Re-confirmer (si dispo) pour cocher ce qui vient d'arriver.
  if (hasConfirm) {
    onProgress("Vérification finale…");
    remote = await confirmedIds(deviceId);
    if (remote) {
      for (const rec of (await DB.all())) {
        if (rec.status !== "sent" && remote.has(String(rec.client_id))) {
          await DB.markSent(rec.client_id, null); confirmes++;
        }
      }
    }
  }

  const restant = (await DB.pending()).length;
  return { confirmes, restant, envoyes, google: isGoogle(), sansConfirm: !hasConfirm, echecsListe };
}

/** Compat : ancienne API « envoyer » → réconciliation. */
export async function envoyer(onProgress = () => {}) {
  const r = await reconcile(onProgress);
  return { envoyees: r.confirmes, echecs: r.restant, copies: null, google: r.google, echecsListe: r.echecsListe };
}
