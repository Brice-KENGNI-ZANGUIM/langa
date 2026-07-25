// Alphabets de langues africaines PRÉ-REMPLIES pour le clavier générique.
// Structure identique à alphabet.data.js (le clavier ne lit que min/maj/graph +
// disposition_lettres + tons + ponctuation/chiffres/symboles/accents_fr).
//
// ⚠️ D'après les ORTHOGRAPHES STANDARD établies (lettres spéciales : ɓ ɗ ŋ ɛ ɔ ƴ ƙ ;
// tons hauts/bas pour les langues tonales). Provisoire — À VALIDER par un locuteur ;
// la communauté peut corriger. Le Swahili n'a pas besoin de clavier dédié (latin
// standard) → il n'est pas ici.
//
// Auteur : Brice Kengni Zanguim.

// — Éléments partagés (communs au français de saisie) —
const PONCT = [".", ",", "?", "!", ";", ":", "-", "'"];
const CHIFFRES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const SYMBOLES = ["«", "»", "(", ")", "…", "/", "'", "%"];
const ACCENTS_FR = [
  { min: "é", maj: "É" }, { min: "è", maj: "È" }, { min: "ê", maj: "Ê" }, { min: "à", maj: "À" },
  { min: "â", maj: "Â" }, { min: "î", maj: "Î" }, { min: "ô", maj: "Ô" }, { min: "û", maj: "Û" }, { min: "ç", maj: "Ç" },
];
const TON_HAUT = { nom: "haut", diacritique: "aigu", combinant: "́", marque: true, exemple: "á" };
const TON_BAS = { nom: "bas", diacritique: "grave", combinant: "̀", marque: true, exemple: "à" };
const TON_MODULE = { nom: "modulé", diacritique: "circonflexe", combinant: "̂", marque: true, exemple: "â" };

// Fabrique un pack alphabet à partir d'un spec compact.
//   voyelles / consonnes = tableaux [min|graph, maj, special?]
//   layout = disposition_lettres (rangées de graphèmes)
function mk({ id, langue, signature, voyelles, consonnes, tons, layout }) {
  const SPECIAL = /[ɓɗŋɛɔʉƴƙ]/;
  return {
    id, langue, normalisation: "NFC", mot_signature: signature || langue,
    voyelles: voyelles.map(([min, maj]) => ({ min, maj, special: SPECIAL.test(min), ipa: "", desc: "", prononce: "", ex: "", ex_fr: "" })),
    consonnes: consonnes.map(([graph, maj, dig]) => ({ graph, maj, special: SPECIAL.test(graph), digramme: !!dig, ipa: "", desc: "", prononce: "", ex: "", ex_fr: "" })),
    tons: tons || [],
    chiffres: CHIFFRES, ponctuation: PONCT, symboles: SYMBOLES, accents_fr: ACCENTS_FR,
    disposition_lettres: layout,
  };
}

// ── Bassa (bas) — Cameroun (A43). Voyelles + implosives ɓ ɗ, ŋ, ny ; tons haut/bas.
export const BASSA = mk({
  id: "bas", langue: "Bassa", signature: "ɓasaa",
  voyelles: [["a", "A"], ["e", "E"], ["ɛ", "Ɛ"], ["i", "I"], ["o", "O"], ["ɔ", "Ɔ"], ["u", "U"]],
  consonnes: [["b", "B"], ["ɓ", "Ɓ"], ["c", "C"], ["d", "D"], ["ɗ", "Ɗ"], ["f", "F"], ["g", "G"], ["h", "H"],
    ["j", "J"], ["k", "K"], ["l", "L"], ["m", "M"], ["n", "N"], ["ny", "Ny", true], ["ŋ", "Ŋ"], ["p", "P"],
    ["s", "S"], ["t", "T"], ["v", "V"], ["w", "W"], ["y", "Y"], ["z", "Z"]],
  tons: [TON_HAUT, TON_BAS, TON_MODULE],
  layout: [
    ["a", "e", "ɛ", "i", "o", "ɔ", "u", "ɓ", "ɗ", "ŋ"],
    ["b", "c", "d", "f", "g", "h", "j", "k", "l", "m"],
    ["n", "ny", "p", "s", "t", "v", "w", "y", "z"],
  ],
});

// ── Douala (dua) — Cameroun (Littoral). Voyelles + ɓ ɗ ŋ ; tons haut/bas/modulé.
export const DOUALA = mk({
  id: "dua", langue: "Douala", signature: "duala",
  voyelles: [["a", "A"], ["e", "E"], ["ɛ", "Ɛ"], ["i", "I"], ["o", "O"], ["ɔ", "Ɔ"], ["u", "U"]],
  consonnes: [["b", "B"], ["ɓ", "Ɓ"], ["d", "D"], ["ɗ", "Ɗ"], ["f", "F"], ["g", "G"], ["h", "H"], ["j", "J"],
    ["k", "K"], ["l", "L"], ["m", "M"], ["n", "N"], ["ny", "Ny", true], ["ŋ", "Ŋ"], ["p", "P"], ["s", "S"],
    ["t", "T"], ["w", "W"], ["y", "Y"]],
  tons: [TON_HAUT, TON_BAS, TON_MODULE],
  layout: [
    ["a", "e", "ɛ", "i", "o", "ɔ", "u", "ɓ", "ɗ", "ŋ"],
    ["b", "d", "f", "g", "h", "j", "k", "l", "m", "n"],
    ["ny", "p", "s", "t", "w", "y"],
  ],
});

// ── Fulfuldé (ful) — Sahel. Implosives ɓ ɗ, ŋ, yod crocheté ƴ ; tons non marqués.
export const FULFULDE = mk({
  id: "ful", langue: "Fulfulde", signature: "fulfulde",
  voyelles: [["a", "A"], ["e", "E"], ["i", "I"], ["o", "O"], ["u", "U"]],
  consonnes: [["b", "B"], ["ɓ", "Ɓ"], ["c", "C"], ["d", "D"], ["ɗ", "Ɗ"], ["f", "F"], ["g", "G"], ["h", "H"],
    ["j", "J"], ["k", "K"], ["l", "L"], ["m", "M"], ["n", "N"], ["ny", "Ny", true], ["ŋ", "Ŋ"], ["p", "P"],
    ["r", "R"], ["s", "S"], ["t", "T"], ["w", "W"], ["y", "Y"], ["ƴ", "Ƴ"]],
  tons: [],
  layout: [
    ["a", "e", "i", "o", "u", "ɓ", "ɗ", "ƴ", "ŋ"],
    ["b", "c", "d", "f", "g", "h", "j", "k", "l", "m"],
    ["n", "ny", "p", "r", "s", "t", "w", "y"],
  ],
});

// ── Haoussa (hau) — Afrique de l'Ouest (boko). Implosives ɓ ɗ, ƙ, ƴ ; digrammes sh ts.
export const HAOUSSA = mk({
  id: "hau", langue: "Hausa", signature: "hausa",
  voyelles: [["a", "A"], ["e", "E"], ["i", "I"], ["o", "O"], ["u", "U"]],
  consonnes: [["b", "B"], ["ɓ", "Ɓ"], ["c", "C"], ["d", "D"], ["ɗ", "Ɗ"], ["f", "F"], ["g", "G"], ["h", "H"],
    ["j", "J"], ["k", "K"], ["ƙ", "Ƙ"], ["l", "L"], ["m", "M"], ["n", "N"], ["r", "R"], ["s", "S"],
    ["sh", "Sh", true], ["t", "T"], ["ts", "Ts", true], ["w", "W"], ["y", "Y"], ["ƴ", "Ƴ"], ["z", "Z"]],
  tons: [],
  layout: [
    ["a", "e", "i", "o", "u", "ɓ", "ɗ", "ƙ", "ƴ"],
    ["b", "c", "d", "f", "g", "h", "j", "k", "l", "m"],
    ["n", "r", "s", "sh", "t", "ts", "w", "y", "z"],
  ],
});

export const ALPHABETS_AFRIQUE = { bas: BASSA, dua: DOUALA, ful: FULFULDE, hau: HAOUSSA };
