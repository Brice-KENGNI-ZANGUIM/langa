// Textes de partage personnalisés par CAS (ce qu'on partage) ET par PLATEFORME (ton + hashtags
// propres à chacune). Fonctions PURES et testables : aucune dépendance au DOM.
//
// shareMessage(caseKey, platform, ctx, lang) → texte marketing prêt à publier (SANS l'URL :
//   l'URL est ajoutée par l'appelant / le lien de partage). Les hashtags, quand la plateforme
//   les accueille, sont déjà inclus à la fin.
//
// Auteur : Brice Kengni Zanguim.

/** Ton + politique de hashtags par plateforme. */
const PLAT = {
  whatsapp: { tone: "chat", tags: null },
  telegram: { tone: "chat", tags: null },
  x: { tone: "punch", tags: "x" },
  facebook: { tone: "descr", tags: "fb" },
  linkedin: { tone: "pro", tags: "pro" },
  instagram: { tone: "caption", tags: "ig" },
  tiktok: { tone: "caption", tags: "ig" },
  email: { tone: "descr", tags: null },
};

/** Jeux de hashtags adaptés à chaque plateforme (courts sur X, sobres/pro sur LinkedIn,
    nombreux sur Instagram/TikTok). */
const HASHTAGS = {
  fr: {
    x: "#LANGIAL #LanguesAfricaines #Afrique",
    fb: "#LANGIAL #LanguesAfricaines #Afrique #PatrimoineVivant #Cameroun",
    pro: "#LANGIAL #LanguesAfricaines #Afrique #Patrimoine #TechForGood",
    ig: "#LANGIAL #LanguesAfricaines #Afrique #PatrimoineVivant #Cameroun #Bamiléké #Ngiemboon #languematernelle #diaspora",
  },
  en: {
    x: "#LANGIAL #AfricanLanguages #Africa",
    fb: "#LANGIAL #AfricanLanguages #Africa #LivingHeritage #Cameroon",
    pro: "#LANGIAL #AfricanLanguages #Africa #Heritage #TechForGood",
    ig: "#LANGIAL #AfricanLanguages #Africa #LivingHeritage #Cameroon #MotherTongue #Ngiemboon #Diaspora #Heritage",
  },
};

function esc(v) { return (v == null ? "" : String(v)).replace(/\s+/g, " ").trim(); }
function ip(s, ctx) { let o = s || ""; for (const k in (ctx || {})) o = o.split("{" + k + "}").join(esc(ctx[k])); return o; }

// Contenu par cas : blocs { hook (accroche courte), what (description), benefit (pourquoi),
// cta (appel à l'action) }. Les cas d'ENTRÉE/DEMANDE sont des fonctions de ctx (mot, langue…).
const CASES = {
  fr: {
    home: { hook: "Nos langues d'Afrique passent au numérique 🌍", what: "LANGIAL rassemble les mots et les voix de nos langues d'Afrique pour en faire des dictionnaires, des claviers et des intelligences artificielles", benefit: "chaque contribution aide à préserver un patrimoine vivant", cta: "Découvre et participe" },
    traduire: { hook: "Et toi, comment dis-tu ça dans ta langue ? 🗣️", what: "Sur LANGIAL, je traduis des mots dans nos langues d'Afrique pour en bâtir des dictionnaires vivants", benefit: "plus on est nombreux, mieux la langue se documente", cta: "Viens ajouter les tiens" },
    transcrire: { hook: "Prête ta voix à ta langue 🎙️", what: "Sur LANGIAL, j'enregistre la prononciation de nos langues d'Afrique pour en garder la voix", benefit: "l'oral se transmet souvent mieux que l'écrit", cta: "Enregistre la tienne" },
    explorer: { hook: "Écoute nos langues d'Afrique 📚", what: "La bibliothèque LANGIAL rassemble mots, voix et traductions partagés par la communauté", benefit: "on apprend en écoutant les autres", cta: "Explore-la et enrichis-la" },
    demander: { hook: "Un mot te manque dans ta langue ? 🙌", what: "Sur LANGIAL, tu demandes à la communauté la traduction ou la prononciation d'un mot dans la langue de ton choix", benefit: "une personne qui parle la langue te répond", cta: "Pose ta question" },
    langues: { hook: "Des dizaines de langues d'Afrique, une par une 🌍", what: "Sur LANGIAL, chaque langue d'Afrique se construit grâce à ses locuteurs", benefit: "la tienne mérite d'y avoir sa place", cta: "Ajoute et fais vivre la tienne" },
    apropos: { hook: "Donner une voix numérique à nos langues 🌍", what: "LANGIAL numérise les langues d'Afrique, en texte et en voix, pour en faire des dictionnaires, des claviers et des IA", benefit: "un patrimoine porté par ses communautés", cta: "Découvre le projet" },
    "entry-trad": (c) => ({ hook: c.tr ? "« {w} » se dit « {tr} » en {lang} 🗣️" : "Comment dit-on « {w} » en {lang} ? 🗣️", what: "Sur LANGIAL, on documente nos langues d'Afrique mot par mot", benefit: "ton avis et ta variante comptent", cta: c.tr ? "Es-tu d'accord ? Propose ta version" : "Aide à la traduire" }),
    "entry-transc": (c) => ({ hook: "Écoute « {w} » prononcé en {lang} 🎙️", what: "Sur LANGIAL, on garde la voix de nos langues d'Afrique", benefit: "chaque prononciation enrichit la langue", cta: "Prête la tienne" }),
    request: (c) => ({ hook: "Quelqu'un cherche « {w} » en {lang} 🙋", what: "Sur LANGIAL, la communauté s'entraide pour traduire et prononcer nos langues d'Afrique", benefit: "", cta: "Tu connais une personne qui parle {lang} ? Partage" }),
  },
  en: {
    home: { hook: "Our African languages are going digital 🌍", what: "LANGIAL gathers the words and voices of our African languages to build dictionaries, keyboards and AI", benefit: "every contribution helps preserve a living heritage", cta: "Discover it and take part" },
    traduire: { hook: "How do you say this in your language? 🗣️", what: "On LANGIAL, I translate words into our African languages to build living dictionaries", benefit: "the more of us there are, the better the language is documented", cta: "Come add yours" },
    transcrire: { hook: "Lend your voice to your language 🎙️", what: "On LANGIAL, I record how our African languages are spoken so their voice is kept", benefit: "speech often carries better than writing", cta: "Record yours" },
    explorer: { hook: "Listen to our African languages 📚", what: "The LANGIAL library gathers words, voices and translations shared by the community", benefit: "you learn by listening to others", cta: "Explore it and grow it" },
    demander: { hook: "Missing a word in your language? 🙌", what: "On LANGIAL, you ask the community to translate or pronounce a word in the language of your choice", benefit: "someone who speaks it answers you", cta: "Ask your question" },
    langues: { hook: "Dozens of African languages, one by one 🌍", what: "On LANGIAL, each African language is built by its own speakers", benefit: "yours deserves a place too", cta: "Add and grow yours" },
    apropos: { hook: "Giving our languages a digital voice 🌍", what: "LANGIAL digitizes African languages, in text and voice, to build dictionaries, keyboards and AI", benefit: "a heritage carried by its communities", cta: "Discover the project" },
    "entry-trad": (c) => ({ hook: c.tr ? "“{w}” is “{tr}” in {lang} 🗣️" : "How do you say “{w}” in {lang}? 🗣️", what: "On LANGIAL, we document our African languages word by word", benefit: "your take and your variant matter", cta: c.tr ? "Do you agree? Suggest your version" : "Help translate it" }),
    "entry-transc": (c) => ({ hook: "Listen to “{w}” spoken in {lang} 🎙️", what: "On LANGIAL, we keep the voice of our African languages", benefit: "every pronunciation enriches the language", cta: "Lend yours" }),
    request: (c) => ({ hook: "Someone is looking for “{w}” in {lang} 🙋", what: "On LANGIAL, the community helps translate and pronounce our African languages", benefit: "", cta: "Do you know someone who speaks {lang}? Share" }),
  },
};

/** Assemble le message selon le TON de la plateforme à partir des blocs du cas.
    Les blocs sont séparés par des RETOURS À LA LIGNE pour aérer le texte (jamais un pavé dense) :
    ligne vide entre les idées sur les plateformes qui laissent respirer (chat/légende/descr),
    saut simple là où l'on reste compact (X, LinkedIn). */
function cap(s) { s = esc(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
function assemble(tone, c) {
  const hook = esc(c.hook), what = esc(c.what), benefit = esc(c.benefit), cta = esc(c.cta);
  const join = (arr, sep) => arr.filter(Boolean).join(sep);
  const ben = benefit ? cap(benefit) + "." : "";
  const whatBen = what ? (what + "." + (ben ? " " + ben : "")) : ben;       // « description. bénéfice. » groupés
  if (tone === "chat") return join([hook, what + ".", cta + " 👇"], "\n\n");        // WhatsApp/Telegram : aéré, personnel
  if (tone === "punch") return join([hook, cta + " 👉"], "\n");                     // X : compact, 2 lignes
  if (tone === "pro") return join([what + ".", ben, cta + "."], "\n\n");            // LinkedIn : sobre, aéré
  if (tone === "caption") return join([hook, ben, cta + " ✨"], "\n\n");            // Instagram/TikTok : légende aérée
  return join([hook, whatBen, cta + "."], "\n\n");                                  // descr (Facebook/e-mail) : 3 blocs aérés
}

/**
 * Texte de partage pour un cas et une plateforme donnés.
 *  caseKey  : home|traduire|transcrire|explorer|demander|langues|apropos|entry-trad|entry-transc|request
 *  platform : whatsapp|telegram|x|facebook|linkedin|instagram|tiktok|email (défaut = générique descr)
 *  ctx      : { w, lang, tr } pour les cas d'entrée/demande
 *  lang     : "fr" | "en"
 */
export function shareMessage(caseKey, platform, ctx, lang) {
  const L = (lang === "en") ? "en" : "fr";
  const plat = PLAT[platform] || { tone: "descr", tags: null };
  let entry = (CASES[L][caseKey] != null) ? CASES[L][caseKey] : CASES[L].home;
  const c = (typeof entry === "function") ? entry(ctx || {}) : entry;
  // interpolation du contexte (mot, langue, traduction) dans les blocs
  const ci = { hook: ip(c.hook, ctx), what: ip(c.what, ctx), benefit: ip(c.benefit, ctx), cta: ip(c.cta, ctx) };
  let msg = assemble(plat.tone, ci);
  if (plat.tags && HASHTAGS[L][plat.tags]) msg += "\n\n" + HASHTAGS[L][plat.tags];
  return msg;
}

/** Objet de l'e-mail par cas (l'objet ne porte pas de hashtag). */
export function shareSubject(caseKey, lang) {
  const L = (lang === "en") ? "en" : "fr";
  const e = CASES[L][caseKey];
  const c = (typeof e === "function") ? e({}) : (e || CASES[L].home);
  return "LANGIAL — " + esc(c && c.hook ? c.hook.replace(/[🌍🗣️🎙️📚🙌]/g, "").trim() : "LANGIAL");
}
