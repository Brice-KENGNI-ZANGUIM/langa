// PACKS DE LANGUE — le CONTENU propre à chaque langue, séparé du MOTEUR générique.
//
// Philosophie (axe modularité) : le moteur (clavier à l'écran, moteur prédictif,
// corpus français partagé) est GÉNÉRIQUE et ne connaît aucune langue en particulier.
// Tout ce qui est SPÉCIFIQUE à une langue vit dans son « pack », rassemblé ICI :
//   - `alphabet` : l'inventaire du clavier DÉDIÉ (voyelles, consonnes, tons, disposition).
//                  Absent → la langue utilise le clavier du système.
//   - `lexicon`  : l'amorce du clavier prédictif (mots RÉELS attestés). Absent → le
//                  prédictif apprend uniquement des contributions de la communauté.
//
// AJOUTER / ENRICHIR UNE LANGUE = une seule entrée dans `LANG_PACKS` ci-dessous. Aucun
// autre fichier n'a besoin de changer : c'est tout l'intérêt de la séparation
// moteur / contenu. Ce module est PUR (aucun état, aucun accès réseau).
//
// Auteur : Brice Kengni Zanguim.

import { NGIEMBOON } from "./keyboard/alphabet.data.js";
import { ALPHABETS_AFRIQUE } from "./keyboard/alphabets_afrique.js";
import { LEXIQUE_NGE } from "./lexique.data.js";

// Registre des packs, indexé par id de langue. Le ngiemboon a un alphabet ET un
// lexique dédiés ; les autres langues pré-remplies (alphabets_afrique.js) reçoivent
// leur alphabet automatiquement plus bas, avec un lexique encore vide (à enrichir).
export const LANG_PACKS = {
  nge: { alphabet: NGIEMBOON, lexicon: LEXIQUE_NGE },
};
// Complète le registre avec les alphabets des autres langues africaines pré-remplies,
// sans écraser un pack déjà défini (lexique vide par défaut : le prédictif apprendra
// des contributions).
for (const id in ALPHABETS_AFRIQUE) {
  if (!LANG_PACKS[id]) LANG_PACKS[id] = { alphabet: ALPHABETS_AFRIQUE[id], lexicon: [] };
}

/** Alphabet du clavier dédié d'une langue, ou null (→ clavier système). */
export function packAlphabet(id) {
  const p = LANG_PACKS[id];
  return (p && p.alphabet) || null;
}
/** Amorce du lexique prédictif d'une langue (mots réels), ou [] (apprend des contributions). */
export function packLexicon(id) {
  const p = LANG_PACKS[id];
  return (p && p.lexicon) || [];
}
/** Cette langue a-t-elle un clavier DÉDIÉ à l'écran ? (vs le clavier du système). */
export function packHasKeyboard(id) {
  return !!packAlphabet(id);
}
/** Pack de CONTENU d'une langue (sans la méta-donnée, qui vit dans languages.js). */
export function contentPack(id) {
  const alphabet = packAlphabet(id);
  const lexicon = packLexicon(id);
  return { id, alphabet, hasDedicatedKeyboard: !!alphabet, lexicon, hasLexicon: lexicon.length > 0 };
}
