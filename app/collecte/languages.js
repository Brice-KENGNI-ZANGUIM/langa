// Registre des LANGUES — LANGIAL, plateforme adaptative et communautaire.
//
// Philosophie : une langue est une DONNÉE, pas du code. La liste des langues vit
// dans le backend ; tout utilisateur peut en DÉCLARER une nouvelle (ex. le Bassa),
// qui devient ensuite visible et choisissable par TOUS, sans intervention. Le socle
// FRANÇAIS (mots, phrases, lettres, symboles — propositions.js) est PARTAGÉ par
// toutes les langues : c'est la matière commune à traduire/transcrire ; chaque
// langue reçoit ses propres traductions/prononciations.
//
// Ce module est la SOURCE UNIQUE côté app pour : la langue graine (ngiemboon, seule
// à disposer d'un clavier dédié aujourd'hui), la langue courante (persistée), et le
// registre (graine + cache distant fusionnés). Le fetch distant et la déclaration
// de langue seront branchés en Phase B (helpers marqués ci-dessous).
//
// Auteur : Brice Kengni Zanguim.

import { packAlphabet, packLexicon, packHasKeyboard, contentPack } from "./langpacks.js";
import { CONFIG } from "./config.js";

// Langue GRAINE : toujours présente, et seule à avoir un clavier dédié pour l'instant.
// `clavier: "nge"` → clavier ngiemboon à l'écran ; toute autre valeur → clavier par
// défaut (clavier du système), avec possibilité pour la communauté de fournir des
// références d'alphabet pour bâtir un clavier dédié plus tard.
export const SEED_LANGUAGES = [
  {
    id: "nge",
    nom: "Ngiemboon",
    autonyme: "Ngiembɔɔn",
    region: "Bamiléké de l'Ouest Cameroun",
    region_en: "Bamileke of West Cameroon",
    clavier: "nge",
    statut: "active",
    graine: true,
    villages: CONFIG.VILLAGES || [],
  },
  // Langues africaines PRÉ-REMPLIES : disponibles d'emblée pour que leurs locuteurs
  // puissent contribuer tout de suite, sans avoir à les déclarer. Inventaires
  // d'après les orthographes standard établies (lettres spéciales / tons indiqués) ;
  // `provisoire: true` = alphabet À VALIDER par un locuteur. Clavier dédié à venir
  // (le Swahili s'écrit en latin standard → clavier système suffisant).
  { id: "swa", nom: "Swahili", autonyme: "Kiswahili",
    region: "Afrique de l'Est (Tanzanie, Kenya, RDC, Ouganda…)", region_en: "East Africa (Tanzania, Kenya, DRC, Uganda…)", clavier: "defaut",
    statut: "active", graine: true, villages: [],
    note: "Alphabet latin standard ; digrammes ch, dh, gh, ng', ny, sh, th ; pas de tons écrits." },
  { id: "bas", nom: "Bassa", autonyme: "Ɓàsàa",
    region: "Cameroun (Sanaga-Maritime, Centre / Littoral)", region_en: "Cameroon (Sanaga-Maritime, Centre / Littoral)", clavier: "defaut",
    statut: "active", graine: true, villages: [], provisoire: true,
    note: "Latin + ɓ ɗ ŋ ɛ ɔ (et ə) ; tons marqués (á à â ǎ)." },
  { id: "dua", nom: "Douala", autonyme: "Duálá",
    region: "Cameroun (Littoral)", region_en: "Cameroon (Littoral)", clavier: "defaut",
    statut: "active", graine: true, villages: [], provisoire: true,
    note: "Latin + ɓ ɗ ŋ ɛ ɔ ; tons (haut/bas/modulé)." },
  { id: "ful", nom: "Fulfuldé (Peul)", autonyme: "Fulfulde",
    region: "Sahel (Cameroun, Nigéria, Niger, Tchad, Mali…)", region_en: "Sahel (Cameroon, Nigeria, Niger, Chad, Mali…)", clavier: "defaut",
    statut: "active", graine: true, villages: [], provisoire: true,
    note: "Latin + ɓ ɗ ŋ ƴ (implosives et yod crocheté)." },
  { id: "hau", nom: "Haoussa", autonyme: "Hausa",
    region: "Afrique de l'Ouest (Nigéria, Niger…)", region_en: "West Africa (Nigeria, Niger…)", clavier: "defaut",
    statut: "active", graine: true, villages: [], provisoire: true,
    note: "Latin (boko) + ɓ ɗ ƙ ƴ ; tons généralement non marqués à l'écrit." },
];

const LS_CURRENT = "langa-lang";        // id de la langue courante (choix utilisateur)
const LS_REGISTRY = "langa-langues";    // cache local du registre distant

// --- Langue courante -------------------------------------------------------
export function getCurrentLangId() {
  return localStorage.getItem(LS_CURRENT) || "nge";
}
export function setCurrentLangId(id) {
  localStorage.setItem(LS_CURRENT, id);
  _cache = null; // le prochain accès relira (au cas où le registre a changé)
}
/** L'utilisateur a-t-il DÉJÀ choisi une langue ? (sinon → écran de choix au 1er accès) */
export function hasChosenLang() {
  return !!localStorage.getItem(LS_CURRENT);
}

// --- Registre : graine + cache distant, fusionnés par id -------------------
let _cache = null;
export function knownLanguages() {
  if (_cache) return _cache;
  let remote = [];
  try { remote = JSON.parse(localStorage.getItem(LS_REGISTRY) || "[]"); } catch { remote = []; }
  const byId = new Map();
  for (const l of SEED_LANGUAGES) byId.set(l.id, l);       // la graine prime
  for (const l of remote) if (l && l.id && !byId.has(l.id)) byId.set(l.id, l);
  _cache = [...byId.values()];
  return _cache;
}
export function getLang(id) {
  return knownLanguages().find((l) => l.id === id) || SEED_LANGUAGES[0];
}
/** Ajoute une langue au registre LOCAL (cache) sans passer par le fetch distant.
    Sert à la déclaration LÉGÈRE depuis la porte « Demander » (le demandeur n'est pas
    forcément locuteur : pas d'amorce). Idempotent par id. */
export function addKnownLanguage(rec) {
  if (!rec || !rec.id || !rec.nom) return;
  let remote = [];
  try { remote = JSON.parse(localStorage.getItem(LS_REGISTRY) || "[]"); } catch { remote = []; }
  if (SEED_LANGUAGES.some((l) => l.id === rec.id) || remote.some((l) => l.id === rec.id)) return;
  remote.push(rec);
  try { localStorage.setItem(LS_REGISTRY, JSON.stringify(remote)); } catch { /* quota */ }
  _cache = null;
}
export function currentLang() {
  return getLang(getCurrentLangId());
}

// --- Alphabet / clavier / pack d'une langue --------------------------------
// Le CONTENU par langue (alphabet du clavier dédié, lexique prédictif) vit dans
// langpacks.js (séparation moteur / contenu). Ces helpers y délèguent, et
// `langPack()` assemble le pack COMPLET = méta-donnée (registre) + contenu.
/** Alphabet du clavier DÉDIÉ d'une langue, sinon null (→ clavier système). */
export function langAlphabet(id) { return packAlphabet(id); }
/** Cette langue a-t-elle un clavier DÉDIÉ à l'écran (vs le clavier du système) ? */
export function usesDedicatedKeyboard(id) { return packHasKeyboard(id); }
/** Amorce du lexique prédictif de la langue (mots réels), ou [] si aucune. */
export function langLexicon(id) { return packLexicon(id); }
/** Pack COMPLET d'une langue : méta-donnée (nom, région, clavier…) + contenu
    (alphabet, lexique). Point d'accès unique côté application. */
export function langPack(id) {
  id = id || getCurrentLangId();
  return Object.assign({ meta: getLang(id) }, contentPack(id));
}

// --- Cache du registre distant (rempli en Phase B par fetchLanguages) ------
export function cacheRemoteLanguages(list) {
  if (!Array.isArray(list)) return;
  // On ne garde que des champs sûrs (pas de PII), assainis à l'affichage.
  const safe = list
    .filter((l) => l && l.id && l.nom)
    .map((l) => ({
      id: String(l.id), nom: String(l.nom),
      autonyme: l.autonyme ? String(l.autonyme) : "",
      region: l.region ? String(l.region) : "",
      region_en: l.region_en ? String(l.region_en) : "",
      pays: l.pays ? String(l.pays) : "",
      // « autres noms / orthographes » (alias) : tolère tableau OU chaîne séparée par , ; /
      alias: Array.isArray(l.alias)
        ? l.alias.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
        : (l.alias ? String(l.alias).split(/[,;/]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12) : []),
      famille: l.famille ? String(l.famille) : "",
      note: l.note ? String(l.note) : "",
      clavier: l.clavier === "nge" ? "nge" : "defaut",
      statut: l.statut || "active",
      // Phase C : si la langue a été fusionnée dans une autre, on garde l'id de sa
      // canonique (pour la masquer de la grille et rediriger vers elle).
      fusionnee_dans: l.fusionnee_dans ? String(l.fusionnee_dans) : "",
    }));
  try { localStorage.setItem(LS_REGISTRY, JSON.stringify(safe)); } catch { /* quota : sans gravité */ }
  _cache = null;
}

// À BRANCHER EN PHASE B :
//   fetchLanguages()  → GET backend (action=languages) puis cacheRemoteLanguages()
//   declareLanguage() → POST backend (op=declare_lang) → visible par tous
