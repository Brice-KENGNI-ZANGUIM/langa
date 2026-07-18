// Gabarits d'e-mails TYPIQUES de LANGA, par cas de figure (FR/EN). Module PUR : il
// se contente de PRODUIRE le sujet + le corps d'un e-mail à partir de données ; il
// n'envoie RIEN. L'envoi réel est DIFFÉRÉ jusqu'à l'acquisition du domaine
// (langia.tech) et d'un service d'e-mail ; ce module sera alors branché sur le même
// catalogue d'événements que les notifications in-app (cf. notifText dans app.js).
//
// Principe : un même événement peut alimenter (1) une notification in-app et
// (2) un e-mail. L'e-mail est un peu plus complet (formule d'appel, contexte, un
// bouton/lien vers l'app, pied avec désabonnement). Le prénom de l'acteur n'apparaît
// que s'il a consenti à l'affichage de son nom (déjà filtré en amont : `actor` vide
// sinon). Aucune donnée personnelle d'un tiers n'est exposée.

const APP_URL_DEFAULT = "https://langia.tech";

function _pick(lang, fr, en) { return lang === "en" ? en : fr; }
function _who(d, lang) { return (d.actor || "").trim() || _pick(lang, "Une personne", "Someone"); }
function _hello(d, lang) {
  const p = (d.prenom || "").trim();
  return p ? _pick(lang, `Bonjour ${p},`, `Hi ${p},`) : _pick(lang, "Bonjour,", "Hi,");
}
function _kindWord(kind, lang) {
  return ({ ok: _pick(lang, "juste", "correct"), doubt: _pick(lang, "à confirmer", "unsure"),
            no: _pick(lang, "à revoir", "to review") })[kind] || _pick(lang, "notée", "rated");
}

// Chaque générateur renvoie { subject, body } en texte simple (l'HTML pourra être
// dérivé plus tard). `data` porte : prenom, actor, mot, kind, langue (nom lisible),
// count, word, appUrl. Toutes les valeurs sont facultatives et tolérées vides.
const GENERATORS = {
  // Un vote a été reçu sur une traduction/transcription de l'utilisateur.
  vote(d, lang) {
    const who = _who(d, lang), mot = (d.mot || "").trim();
    return {
      subject: _pick(lang, `${who} a noté ta traduction sur LANGA`, `${who} rated your translation on LANGA`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `${who} vient de donner son avis sur ta traduction de « ${mot} » : ${_kindWord(d.kind, lang)}.`,
          `${who} just gave their take on your translation of “${mot}”: ${_kindWord(d.kind, lang)}.`),
        _pick(lang,
          "Les avis de la communauté font monter la qualité de la langue. Va voir ce qui se dit et réponds si tu veux.",
          "Community feedback raises the quality of the language. Have a look and reply if you like."),
      ].join("\n"),
    };
  },
  // Une correction / amélioration a été proposée sur une contribution.
  suggestion(d, lang) {
    const who = _who(d, lang), mot = (d.mot || "").trim();
    return {
      subject: _pick(lang, `${who} a amélioré ta contribution « ${mot} »`, `${who} improved your contribution “${mot}”`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `${who} a proposé une amélioration sur ta contribution « ${mot} ». Tu peux la découvrir, la comparer, et garder la meilleure version.`,
          `${who} suggested an improvement to your contribution “${mot}”. You can review it, compare, and keep the best version.`),
      ].join("\n"),
    };
  },
  // La langue de l'utilisateur a franchi un palier de contributions.
  milestone(d, lang) {
    const langue = (d.langue || "").trim() || _pick(lang, "ta langue", "your language");
    const n = d.count || 0;
    return {
      subject: _pick(lang, `Bravo : ${langue} a franchi ${n} contributions`, `Well done: ${langue} reached ${n} contributions`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `Grâce à toi et à la communauté, ${langue} vient de franchir le cap de ${n} contributions. Chaque mot et chaque voix rapprochent la langue d'un vrai dictionnaire et d'outils numériques.`,
          `Thanks to you and the community, ${langue} just crossed ${n} contributions. Every word and voice bring the language closer to a real dictionary and digital tools.`),
      ].join("\n"),
    };
  },
  // Invitation à traduire un mot pas encore fait (nudge personnalisé).
  incite_translate(d, lang) {
    const word = (d.word || "").trim(), langue = (d.langue || "").trim();
    return {
      subject: _pick(lang, `Comment dit-on « ${word} » dans ta langue ?`, `How do you say “${word}” in your language?`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `Un petit geste aujourd'hui : dis-nous comment on dit « ${word} »${langue ? ` en ${langue}` : ""}. Écris-le ou prête ta voix, en une minute.`,
          `A small gesture today: tell us how to say “${word}”${langue ? ` in ${langue}` : ""}. Write it or lend your voice, in a minute.`),
      ].join("\n"),
    };
  },
  // Invitation à noter les propositions des autres (qualité des données).
  incite_rate(d, lang) {
    const word = (d.word || "").trim(), langue = (d.langue || "").trim();
    return {
      subject: _pick(lang, `Es-tu d'accord avec cette traduction de « ${word} » ?`, `Do you agree with this translation of “${word}”?`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `Quelqu'un a proposé une traduction de « ${word} »${langue ? ` en ${langue}` : ""}. Ton avis compte : juste, doute ou faux, en un clic.`,
          `Someone proposed a translation of “${word}”${langue ? ` in ${langue}` : ""}. Your take matters: correct, unsure or wrong, in one click.`),
      ].join("\n"),
    };
  },
  // Une demande de traduction a été lancée dans une langue que le destinataire PARLE.
  request(d, lang) {
    const mot = (d.mot || "").trim(), langue = (d.langue || "").trim();
    return {
      subject: _pick(lang, `Quelqu'un cherche « ${mot} » dans ta langue`, `Someone is looking for “${mot}” in your language`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `Une personne cherche à savoir comment on dit « ${mot} »${langue ? ` en ${langue}` : ""}. Tu parles cette langue : quelques secondes suffisent pour l'aider, en écrivant le mot ou en prêtant ta voix.`,
          `Someone wants to know how to say “${mot}”${langue ? ` in ${langue}` : ""}. You speak this language: a few seconds are enough to help, by writing the word or lending your voice.`),
      ].join("\n"),
    };
  },
  // Une demande dans une langue que le destinataire NE parle pas : on l'invite à RELAYER.
  // `share` = message tout prêt à copier/coller sur ses réseaux (préparé par l'app).
  request_share(d, lang) {
    const mot = (d.mot || "").trim(), langue = (d.langue || "").trim();
    const share = (d.share || "").trim();
    return {
      subject: _pick(lang, `Aide à trouver « ${mot} » : partage cette demande`, `Help find “${mot}”: share this request`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `Quelqu'un cherche la traduction de « ${mot} »${langue ? ` en ${langue}` : ""}. Tu ne parles peut-être pas cette langue, mais tu connais sûrement quelqu'un qui la parle. Partage ce message autour de toi (WhatsApp, Facebook, tes proches) :`,
          `Someone is looking for the translation of “${mot}”${langue ? ` in ${langue}` : ""}. You may not speak it, but you surely know someone who does. Share this message around you (WhatsApp, Facebook, your circle):`),
        share ? ("\n« " + share + " »") : "",
      ].join("\n"),
    };
  },
  // On a répondu à la demande de l'utilisateur.
  request_answered(d, lang) {
    const who = _who(d, lang), mot = (d.mot || "").trim();
    return {
      subject: _pick(lang, `${who} a répondu à ta demande « ${mot} »`, `${who} answered your request “${mot}”`),
      body: [
        _hello(d, lang), "",
        _pick(lang,
          `Bonne nouvelle : ${who} a répondu à ta demande de traduction de « ${mot} ». Va voir la réponse sur LANGA.`,
          `Good news: ${who} answered your translation request for “${mot}”. Check the answer on LANGA.`),
      ].join("\n"),
    };
  },
  // Résumé périodique (tous les 2 jours) : agrège l'activité récente.
  digest(d, lang) {
    const items = Array.isArray(d.items) ? d.items : [];
    const lines = items.length
      ? items.map((x) => "  - " + x).join("\n")
      : _pick(lang, "  - (rien de neuf cette fois, mais ta langue t'attend)", "  - (nothing new this time, but your language awaits)");
    return {
      subject: _pick(lang, "Ce qui s'est passé autour de tes contributions", "What happened around your contributions"),
      body: [
        _hello(d, lang), "",
        _pick(lang, "Voici un résumé des derniers jours :", "Here is a summary of the last few days:"),
        lines,
      ].join("\n"),
    };
  },
};

/** Pied commun (lien vers l'app + désabonnement), ajouté à tout e-mail. */
function _footer(d, lang) {
  const url = (d.appUrl || APP_URL_DEFAULT);
  return "\n\n" + [
    _pick(lang, `Ouvre LANGA : ${url}`, `Open LANGA: ${url}`),
    _pick(lang, "Tu reçois cet e-mail parce que tu contribues à LANGA. Pour ne plus en recevoir, réponds « STOP ».",
                "You receive this email because you contribute to LANGA. To stop receiving them, reply “STOP”."),
  ].join("\n");
}

/** Produit { subject, body } pour un type d'e-mail donné. `type` ∈ clés de GENERATORS.
    `data` = données de l'événement ; `lang` = "fr" (défaut) ou "en". PURE. */
export function mailTemplate(type, data, lang) {
  const l = lang === "en" ? "en" : "fr";
  const gen = GENERATORS[type];
  if (!gen) return null;
  const out = gen(data || {}, l);
  return { subject: out.subject, body: out.body + _footer(data || {}, l) };
}

/** Liste des types d'e-mails disponibles (pour le futur moteur d'envoi). */
export function mailTypes() { return Object.keys(GENERATORS); }
