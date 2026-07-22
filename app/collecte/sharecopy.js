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
    home: { hook: "Laissons nos langues en héritage 🌍", what: "LANGIAL rassemble les mots et les voix de nos langues d'Afrique : ceux qui les connaissent les transmettent, et chacun peut les apprendre", benefit: "chaque contribution est un cadeau laissé aux générations futures, pour qu'elles n'oublient pas d'où elles viennent", cta: "Découvre et laisse ta trace" },
    traduire: { hook: "Transmets ta langue, un mot à la fois 🗣️", what: "Sur LANGIAL, je traduis nos langues d'Afrique pour les transmettre à celles et ceux qui veulent les apprendre", benefit: "chaque mot devient un héritage laissé aux générations futures", cta: "Ajoute les tiens" },
    transcrire: { hook: "Laisse ta voix en héritage 🎙️", what: "Sur LANGIAL, j'enregistre la prononciation de nos langues d'Afrique pour que leur voix ne s'oublie jamais", benefit: "l'oral se transmet, d'une génération à l'autre", cta: "Prête la tienne" },
    explorer: { hook: "Apprends nos langues d'Afrique en les écoutant 📚", what: "La bibliothèque LANGIAL rassemble les mots et les voix transmis par la communauté", benefit: "on apprend des autres et on garde la mémoire vivante", cta: "Explore-la et enrichis-la" },
    demander: { hook: "Un mot te manque ? Quelqu'un peut te le transmettre 🙌", what: "Sur LANGIAL, tu demandes à la communauté un mot ou sa prononciation dans la langue de ton choix", benefit: "ceux qui savent transmettent à ceux qui apprennent", cta: "Pose ta question" },
    langues: { hook: "Ta langue mérite d'être transmise 🌍", what: "Sur LANGIAL, chaque langue d'Afrique se construit et se transmet grâce à ses locuteurs", benefit: "ajoute la tienne et laisse-la en héritage", cta: "Ajoute et fais vivre la tienne" },
    apropos: { hook: "Un héritage pour nos langues d'Afrique 🌍", what: "LANGIAL rassemble les mots et les voix de nos langues d'Afrique : les transmettre, les apprendre, ne pas les oublier", benefit: "un cadeau porté par ses communautés, pour les générations futures", cta: "Découvre le projet" },
    "entry-trad": (c) => ({ hook: c.tr ? "« {w} » se dit « {tr} » en {lang} 🗣️" : "Comment dit-on « {w} » en {lang} ? 🗣️", what: "Sur LANGIAL, on documente nos langues d'Afrique mot par mot", benefit: "ton avis et ta variante comptent", cta: c.tr ? "Es-tu d'accord ? Propose ta version" : "Aide à la traduire" }),
    "entry-transc": (c) => ({ hook: "Écoute « {w} » prononcé en {lang} 🎙️", what: "Sur LANGIAL, on garde la voix de nos langues d'Afrique", benefit: "chaque prononciation enrichit la langue", cta: "Prête la tienne" }),
    request: (c) => ({ hook: "Quelqu'un cherche « {w} » en {lang} 🙋", what: "Sur LANGIAL, la communauté s'entraide pour traduire et prononcer nos langues d'Afrique", benefit: "", cta: "Tu connais une personne qui parle {lang} ? Partage" }),
  },
  en: {
    home: { hook: "Let's leave our languages as a legacy 🌍", what: "LANGIAL gathers the words and voices of our African languages: those who know pass them on, and anyone can learn them", benefit: "every contribution is a gift for future generations, so they don't forget where they come from", cta: "Discover it and leave your mark" },
    traduire: { hook: "Pass on your language, one word at a time 🗣️", what: "On LANGIAL, I translate our African languages to pass them on to those who want to learn them", benefit: "each word becomes a heritage for future generations", cta: "Add yours" },
    transcrire: { hook: "Leave your voice as a legacy 🎙️", what: "On LANGIAL, I record how our African languages are spoken so their voice is never forgotten", benefit: "speech passes on, from one generation to the next", cta: "Record yours" },
    explorer: { hook: "Learn our African languages by listening 📚", what: "The LANGIAL library gathers the words and voices passed on by the community", benefit: "you learn from others and keep the memory alive", cta: "Explore it and grow it" },
    demander: { hook: "Missing a word? Someone can pass it on to you 🙌", what: "On LANGIAL, you ask the community for a word or its pronunciation in the language of your choice", benefit: "those who know pass it on to those who learn", cta: "Ask your question" },
    langues: { hook: "Your language deserves to be passed on 🌍", what: "On LANGIAL, each African language is built and passed on by its own speakers", benefit: "add yours and leave it as a legacy", cta: "Add and grow yours" },
    apropos: { hook: "A heritage for our African languages 🌍", what: "LANGIAL gathers the words and voices of our African languages: passing them on, learning them, not forgetting them", benefit: "a gift carried by its communities, for future generations", cta: "Discover the project" },
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
