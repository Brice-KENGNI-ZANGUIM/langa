// Contenu du popup de remerciement affiché quand une contribution vient d'être CONFIRMÉE en
// base (pas au simple enregistrement local : au moment où le serveur l'a reçue). Le message et
// le visuel varient (1re contribution / palier / envoi courant, pool tourné au hasard) pour ne
// jamais répéter deux fois la même chose et pour porter la voix héritage/transmission/
// apprentissage. Module pur, sans dépendance au DOM, testable indépendamment de l'UI.
//
// Paliers RÉGULIERS et RAPPROCHÉS (tous les 5, Brice 2026-07-24) plutôt que rares et espacés :
// la régularité fait sentir à l'utilisateur qu'il compte, tout de suite et souvent, pas
// seulement à de grandes étapes lointaines. Pour que cette fréquence ne devienne jamais
// mécanique, chaque palier tire à la fois un TEXTE et un HABILLAGE visuel (« skin » — couleurs,
// halo, médaille) parmi un pool large, indépendamment l'un de l'autre : la combinatoire rend la
// répétition improbable à l'œil, même si le nombre de messages est fini.
//
// Auteur : Brice Kengni Zanguim.

function ip(s, ctx) {
  let o = s || "";
  for (const k in (ctx || {})) o = o.split("{" + k + "}").join(String(ctx[k]));
  return o;
}
function pick(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

const FIRST = {
  fr: { title: "Ta toute première contribution", body: "Elle est enregistrée pour de bon dans la base : un mot de ta langue qui ne se perdra plus. Merci d'avoir fait ce premier pas." },
  en: { title: "Your very first contribution", body: "It's now safely stored in the archive: one more word of your language that won't be lost. Thank you for taking this first step." },
};

// Habillage visuel (couleurs du médaillon + halo derrière lui) : tourné au hasard, INDÉPENDAMMENT
// du texte, sur les paliers ET les envois courants. Palette FIXE (pas theme-dépendante), comme
// --nav-gold ailleurs dans l'app : un médaillon reste le même bijou en clair comme en sombre.
const SKINS = ["or", "argent", "bronze", "amethyste", "cuivre", "onyx", "ivoire"];
function pickSkin() { return pick(SKINS); }

// Paliers : un moment un peu plus marqué que les envois courants, TOUS LES 5 (régularité voulue).
export function isMilestoneCount(n) { return n > 0 && n % 5 === 0; }

const MILESTONE_MSG = {
  fr: [
    { title: "{n} contributions franchies", body: "Chaque mot que tu donnes est une pierre de plus dans la mémoire de ta langue. Continue, c'est un vrai trésor que tu bâtis." },
    { title: "Cap des {n} atteint", body: "Ce que tu transmets aujourd'hui, quelqu'un l'apprendra demain. Merci pour cette régularité." },
    { title: "{n} contributions, merci", body: "Peu de gens donnent autant de leur temps pour que leur langue reste vivante. La communauté te le doit." },
    { title: "{n}, et ça continue", body: "Un chiffre de plus, mais surtout une preuve : tu tiens la distance, et ta langue en sort grandie." },
    { title: "{n} pas de plus", body: "Chaque palier que tu franchis rapproche un peu plus ta langue d'un vrai dictionnaire vivant." },
    { title: "{n} fois merci", body: "Littéralement : {n} fois où tu as choisi de donner un peu de ton temps à ta langue. Ça se voit, et ça compte." },
    { title: "{n} contributions bien réelles", body: "Rien d'automatique là-dedans : {n} choix délibérés de transmettre. Continue, tu es sur une belle lancée." },
    { title: "Palier des {n}", body: "Ce que tu construis mot après mot ne s'effacera pas. Merci de continuer, régulièrement, sans bruit." },
  ],
  en: [
    { title: "{n} contributions reached", body: "Every word you give is one more stone in your language's memory. Keep going, you're building a real treasure." },
    { title: "{n}-contribution milestone", body: "What you pass on today, someone will learn tomorrow. Thank you for this steady work." },
    { title: "{n} contributions, thank you", body: "Few people give this much of their time to keep their language alive. The community owes you for it." },
    { title: "{n}, and counting", body: "One more number, but mostly proof: you're staying the course, and your language is better for it." },
    { title: "{n} steps further", body: "Every milestone you cross brings your language a little closer to a real, living dictionary." },
    { title: "{n} times, thank you", body: "Literally: {n} times you chose to give a bit of your time to your language. It shows, and it matters." },
    { title: "{n} very real contributions", body: "Nothing automatic here: {n} deliberate choices to pass something on. Keep this streak going." },
    { title: "Milestone: {n}", body: "What you're building word by word won't fade away. Thank you for keeping at it, quietly, regularly." },
  ],
};

const REGULAR = {
  fr: [
    { icon: "🌿", title: "Contribution enregistrée", body: "Un fragment de plus de ton héritage, gardé pour de bon dans la base." },
    { icon: "✨", title: "Merci pour ce mot", body: "Il fera peut-être partie de ce qu'apprendra un enfant, demain." },
    { icon: "🤝", title: "Envoyée et confirmée", body: "Ta langue avance d'un mot grâce à toi." },
    { icon: "🌍", title: "Bien reçu", body: "Ce que tu transmets aujourd'hui ne se perdra plus jamais." },
    { icon: "🔥", title: "Ça compte vraiment", body: "Continue, chaque contribution a de la valeur pour la communauté." },
    { icon: "🌾", title: "En sécurité dans la base", body: "Merci de semer aujourd'hui pour les générations à venir." },
    { icon: "🎁", title: "Un cadeau de plus", body: "C'est exactement ça, un héritage : merci de l'agrandir un peu." },
    { icon: "🌱", title: "Ça pousse", body: "Un mot de plus, une racine de plus. Ta langue grandit un peu grâce à toi aujourd'hui." },
    { icon: "🕊️", title: "Transmis", body: "C'est fait, c'est gardé, et ça voyagera jusqu'à quelqu'un qui en avait besoin." },
    { icon: "💛", title: "Sincèrement merci", body: "Pas un message automatique : un vrai merci, pour le temps que tu viens de donner." },
  ],
  en: [
    { icon: "🌿", title: "Contribution saved", body: "One more piece of your heritage, kept for good in the archive." },
    { icon: "✨", title: "Thank you for this word", body: "It might become part of what a child learns, tomorrow." },
    { icon: "🤝", title: "Sent and confirmed", body: "Your language moves forward by one word, thanks to you." },
    { icon: "🌍", title: "Received", body: "What you share today will never be lost again." },
    { icon: "🔥", title: "It truly matters", body: "Keep going, every contribution has real value for the community." },
    { icon: "🌾", title: "Safely stored", body: "Thank you for planting today for the generations to come." },
    { icon: "🎁", title: "One more gift", body: "That's exactly what a heritage is: thank you for growing it a little more." },
    { icon: "🌱", title: "It's growing", body: "One more word, one more root. Your language grows a little today, because of you." },
    { icon: "🕊️", title: "Passed on", body: "It's done, it's kept, and it will travel all the way to someone who needed it." },
    { icon: "💛", title: "Sincerely, thank you", body: "Not an automated message: a real thank you, for the time you just gave." },
  ],
};

const MULTI = {
  fr: (k) => ({ title: k + " contributions confirmées", body: "Merci, chacune d'elles compte et vient enrichir la mémoire de ta langue." }),
  en: (k) => ({ title: k + " contributions confirmed", body: "Thank you, each one matters and enriches your language's memory." }),
};

/** Choisit le contenu du popup de remerciement.
    total = nb total d'envois confirmés sur cet appareil (compteur local, après ce tick) ;
    justConfirmed = nb d'envois confirmés PENDANT ce tick (peut être > 1, un seul popup alors) ;
    lang = "fr" | "en" (langue d'interface courante). */
export function pickThanksContent(total, justConfirmed, lang) {
  const L = (lang === "en") ? "en" : "fr";
  if (justConfirmed > 1) {
    const m = MULTI[L](justConfirmed);
    return { title: m.title, body: m.body, visual: "regular", icon: "🎉", skin: pickSkin() };
  }
  if (total === 1) {
    const f = FIRST[L];
    return { title: f.title, body: f.body, visual: "photo", skin: pickSkin() };
  }
  if (isMilestoneCount(total)) {
    const p = pick(MILESTONE_MSG[L]);
    return { title: ip(p.title, { n: total }), body: ip(p.body, { n: total }), visual: "milestone", n: total, skin: pickSkin() };
  }
  const p = pick(REGULAR[L]);
  return { title: p.title, body: p.body, visual: "regular", icon: p.icon, skin: pickSkin() };
}
