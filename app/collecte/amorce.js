// AMORCE SONORE — le noyau universel de mots/phrases du quotidien, commun à TOUTES
// les langues. Quand quelqu'un crée une nouvelle langue, on lui demande d'en prononcer
// au moins quelques-uns : ces enregistrements deviennent les « transcriptions minimales »
// de la langue, sa toute première voix. Comme la liste est la MÊME pour toutes les
// langues, elle rend les langues comparables entre elles dès le départ (un socle partagé,
// dans l'esprit d'une liste de Swadesh mais résolument quotidienne et chaleureuse).
//
// Chaque entrée : { id, fr, cat }. `fr` = le mot/la phrase en français (langue-pont) ;
// l'utilisateur enregistre sa VOIX qui le dit dans sa langue. `cat` = regroupement
// pour un affichage clair. Fidèle à la liste proposée par Brice, complétée de quelques
// universels (nombres, nature, besoins) présents dans toutes les cultures.
//
// Auteur : Brice Kengni Zanguim.

export const AMORCE = [
  // — Famille & personnes —
  { id: "papa", fr: "Papa", cat: "Famille & personnes" },
  { id: "maman", fr: "Maman", cat: "Famille & personnes" },
  { id: "enfant", fr: "Enfant", cat: "Famille & personnes" },
  { id: "frere", fr: "Frère", cat: "Famille & personnes" },
  { id: "soeur", fr: "Sœur", cat: "Famille & personnes" },
  { id: "famille", fr: "Famille", cat: "Famille & personnes" },
  { id: "ami", fr: "Ami", cat: "Famille & personnes" },
  { id: "femme", fr: "Femme", cat: "Famille & personnes" },
  { id: "homme", fr: "Homme", cat: "Famille & personnes" },

  // — Salutations —
  { id: "bonjour", fr: "Bonjour", cat: "Salutations" },
  { id: "aurevoir", fr: "Au revoir", cat: "Salutations" },
  { id: "bonne-soiree", fr: "Bonne soirée", cat: "Salutations" },
  { id: "bonne-journee", fr: "Passe une bonne journée", cat: "Salutations" },
  { id: "merci", fr: "Merci", cat: "Salutations" },

  // — Petites phrases du quotidien —
  { id: "ta-journee", fr: "Comment était ta journée ?", cat: "Phrases du quotidien" },
  { id: "tu-as-mange", fr: "Tu as mangé ?", cat: "Phrases du quotidien" },
  { id: "je-bois-eau", fr: "Je bois de l'eau", cat: "Phrases du quotidien" },
  { id: "je-mange", fr: "Je mange", cat: "Phrases du quotidien" },
  { id: "je-viens-en-paix", fr: "Je viens en paix", cat: "Phrases du quotidien" },
  { id: "je-travaille", fr: "Je travaille", cat: "Phrases du quotidien" },

  // — Actions —
  { id: "marcher", fr: "Marcher", cat: "Actions" },
  { id: "courir", fr: "Courir", cat: "Actions" },
  { id: "manger", fr: "Manger", cat: "Actions" },
  { id: "boire", fr: "Boire", cat: "Actions" },
  { id: "dormir", fr: "Dormir", cat: "Actions" },
  { id: "cuisiner", fr: "Cuisiner", cat: "Actions" },
  { id: "travailler", fr: "Travailler", cat: "Actions" },

  // — Valeurs & émotions —
  { id: "paix", fr: "Paix", cat: "Valeurs & émotions" },
  { id: "amour", fr: "Amour", cat: "Valeurs & émotions" },
  { id: "gentil", fr: "Gentil", cat: "Valeurs & émotions" },
  { id: "heureux", fr: "Heureux", cat: "Valeurs & émotions" },
  { id: "joyeux", fr: "Joyeux", cat: "Valeurs & émotions" },

  // — Nombres —
  { id: "un", fr: "Un", cat: "Nombres" },
  { id: "deux", fr: "Deux", cat: "Nombres" },
  { id: "trois", fr: "Trois", cat: "Nombres" },

  // — Nature & besoins —
  { id: "eau", fr: "Eau", cat: "Nature & besoins" },
  { id: "feu", fr: "Feu", cat: "Nature & besoins" },
  { id: "soleil", fr: "Soleil", cat: "Nature & besoins" },
  { id: "nuit", fr: "Nuit", cat: "Nature & besoins" },
  { id: "maison", fr: "Maison", cat: "Nature & besoins" },
  { id: "nourriture", fr: "Nourriture", cat: "Nature & besoins" },
  { id: "ecole", fr: "École", cat: "Nature & besoins" },
];

// Nombre MINIMUM d'enregistrements requis pour accompagner la création d'une langue.
// RÈGLE STRICTE (Brice, 2026-07-27, « à tout prix ») : en dessous de ce seuil, la langue
// N'EST JAMAIS créée — ni déclarée au backend (invisible pour les autres), ni conservée
// localement au-delà de la session en cours. Personne ne doit pouvoir déclarer une langue
// « juste pour le plaisir » sans en connaître et prononcer au moins quelques mots de base.
export const AMORCE_MIN = 5;
