// Équivalents ANGLAIS des items SOURCES (le mot/nombre à traduire ou transcrire), afin
// d'afficher le prompt dans la langue d'interface. Utilisé pour les utilisateurs passés
// en anglais : ils lisent l'item en anglais pour bien le comprendre avant de traduire.
//
// PRINCIPE : ne contient QUE des traductions VÉRIFIÉES. Tout item non couvert retombe sur
// le français (jamais d'invention). Le stockage de la contribution garde toujours le mot
// source CANONIQUE (français) → le regroupement Explorer reste cohérent quelle que soit la
// langue d'interface. Le dictionnaire est EXTENSIBLE : ajouter des paires ici enrichit la
// couverture anglaise, sans rien changer d'autre.
//
// Auteur : Brice Kengni Zanguim.

// Chiffres (0 à 9) et nombres — équivalents déterministes.
const NOMBRES = {
  "zéro": "zero", "un": "one", "deux": "two", "trois": "three", "quatre": "four",
  "cinq": "five", "six": "six", "sept": "seven", "huit": "eight", "neuf": "nine",
  "dix": "ten", "onze": "eleven", "douze": "twelve", "treize": "thirteen", "quatorze": "fourteen",
  "quinze": "fifteen", "seize": "sixteen", "dix-sept": "seventeen", "dix-huit": "eighteen", "dix-neuf": "nineteen",
  "vingt": "twenty", "vingt et un": "twenty-one", "vingt-deux": "twenty-two", "vingt-cinq": "twenty-five",
  "trente": "thirty", "trente-cinq": "thirty-five", "quarante": "forty", "quarante-cinq": "forty-five",
  "cinquante": "fifty", "soixante": "sixty", "soixante-dix": "seventy", "quatre-vingts": "eighty",
  "quatre-vingt-dix": "ninety", "cent": "one hundred", "cent un": "one hundred and one",
  "deux cents": "two hundred", "cinq cents": "five hundred", "sept cent cinquante": "seven hundred and fifty",
  "mille": "one thousand", "deux mille": "two thousand", "cinq mille": "five thousand", "dix mille": "ten thousand",
  "cent mille": "one hundred thousand", "un million": "one million", "dix millions": "ten million",
  "un milliard": "one billion", "premier": "first", "deuxième": "second", "troisième": "third", "dernier": "last",
  "la moitié": "half", "le quart": "a quarter", "le tiers": "a third", "une paire": "a pair",
  "une dizaine": "about ten", "une douzaine": "a dozen", "une centaine": "about a hundred", "un millier": "about a thousand",
};

// Parenté (domaine « famille ») — traductions non ambiguës.
const PARENTE = {
  "père": "father", "mère": "mother", "enfant": "child", "fils": "son", "fille": "daughter",
  "frère": "brother", "sœur": "sister", "grand-père": "grandfather", "grand-mère": "grandmother",
  "mari": "husband", "femme": "woman", "époux": "husband", "épouse": "wife",
  "oncle": "uncle", "tante": "aunt", "cousin": "cousin", "cousine": "cousin", "neveu": "nephew", "nièce": "niece",
  "beau-père": "father-in-law", "belle-mère": "mother-in-law", "gendre": "son-in-law", "belle-fille": "daughter-in-law",
  "beau-frère": "brother-in-law", "belle-sœur": "sister-in-law", "jumeau": "twin", "jumelle": "twin",
  "aîné": "eldest child", "cadet": "younger child", "orphelin": "orphan",
};

const DICT = Object.assign({}, NOMBRES, PARENTE);

/** Équivalent ANGLAIS d'un item source français, ou null si non couvert (→ repli français). */
export function sourceEn(fr) {
  if (fr == null) return null;
  const s = String(fr).trim();
  if (!s) return null;
  if (/^[A-Za-z]$/.test(s)) return s.toUpperCase();   // lettres isolées : identiques
  const k = s.toLowerCase();
  return Object.prototype.hasOwnProperty.call(DICT, k) ? DICT[k] : null;
}

/** Nombre d'items couverts (diagnostic / tests). */
export function sourceEnCount() { return Object.keys(DICT).length; }
