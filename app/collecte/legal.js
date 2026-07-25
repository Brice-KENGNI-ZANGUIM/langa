// Pages légales de LANGIAL (mentions légales, confidentialité, CGU, CGV), bilingues FR/EN.
// Contenu STATIQUE et de confiance (aucune entrée utilisateur) → rendu via innerHTML sûr.
// Ton honnête, adapté à une plateforme communautaire GRATUITE de collecte linguistique ;
// aucune mention d'infrastructure interne. Contact unique : Brice Kengni Zanguim.
//
// Auteur : Brice Kengni Zanguim.

const CONTACT = 'kenzabri2@yahoo.com';

export const LEGAL_SECTIONS = [
  {
    id: "mentions",
    t: { fr: "Mentions légales", en: "Legal notice" },
    html: {
      fr: `
        <p><b>Éditeur.</b> LANGIAL est un projet indépendant, à but non lucratif, porté par <b>Brice Kengni Zanguim</b>.</p>
        <p><b>Directeur de la publication.</b> Brice Kengni Zanguim.</p>
        <p><b>Contact.</b> <a href="mailto:${CONTACT}">${CONTACT}</a> · WhatsApp : +33 7 72 08 82 36.</p>
        <p><b>Hébergement du site.</b> Le site est hébergé par GitHub Pages (GitHub, Inc., 88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, États-Unis).</p>
        <p><b>Objet.</b> LANGIAL est une plateforme communautaire et gratuite de collecte et de valorisation des langues d'Afrique, en texte et en voix.</p>`,
      en: `
        <p><b>Publisher.</b> LANGIAL is an independent, non-profit project led by <b>Brice Kengni Zanguim</b>.</p>
        <p><b>Publication director.</b> Brice Kengni Zanguim.</p>
        <p><b>Contact.</b> <a href="mailto:${CONTACT}">${CONTACT}</a> · WhatsApp: +33 7 72 08 82 36.</p>
        <p><b>Hosting.</b> The site is hosted by GitHub Pages (GitHub, Inc., 88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, USA).</p>
        <p><b>Purpose.</b> LANGIAL is a community, free platform to collect and promote Africa's languages, in text and voice.</p>`,
    },
  },
  {
    id: "confidentialite",
    t: { fr: "Politique de confidentialité", en: "Privacy policy" },
    html: {
      fr: `
        <p>LANGIAL respecte ta vie privée et ne collecte que le strict nécessaire à sa mission.</p>
        <p><b>Données recueillies.</b> À la création de ton profil : nom, prénom, village ou variante, rôle (locuteur natif, apprenant, linguiste), e-mail et téléphone. Avec tes contributions : les mots, phrases, traductions et enregistrements vocaux que tu ajoutes.</p>
        <p><b>Pourquoi.</b> Pour te créditer comme contributeur, te recontacter en cas de doute sur une contribution, et documenter et outiller la langue.</p>
        <p><b>Base légale.</b> Ton consentement explicite, donné en cochant la case prévue avant de contribuer.</p>
        <p><b>Conservation et accès.</b> Ton profil est enregistré sur ton appareil. Tes contributions sont conservées en lieu sûr pour construire le corpus commun de la langue. Ton e-mail et ton téléphone ne sont <b>jamais</b> affichés publiquement.</p>
        <p><b>Ce qui est public.</b> Seules tes contributions apparaissent dans la bibliothèque publique, et, uniquement si tu l'autorises, le nom d'affichage que tu as choisi.</p>
        <p><b>Pas de vente.</b> Tes données ne sont ni vendues ni cédées à des tiers à des fins commerciales, ni utilisées pour de la publicité.</p>
        <p><b>Tes droits.</b> Tu peux à tout moment demander l'accès, la correction ou la suppression de tes données en écrivant à <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
        <p><b>Mineurs.</b> Si tu as moins de 18 ans, demande l'accord d'un parent ou tuteur avant de contribuer.</p>`,
      en: `
        <p>LANGIAL respects your privacy and collects only what its mission strictly requires.</p>
        <p><b>Data collected.</b> When you create your profile: last name, first name, village or variant, role (native speaker, learner, linguist), email and phone. With your contributions: the words, phrases, translations and voice recordings you add.</p>
        <p><b>Why.</b> To credit you as a contributor, to get back to you if a contribution needs clarifying, and to document and equip the language.</p>
        <p><b>Legal basis.</b> Your explicit consent, given by ticking the box shown before you contribute.</p>
        <p><b>Storage and access.</b> Your profile is stored on your device. Your contributions are kept in a safe place to build the shared corpus of the language. Your email and phone are <b>never</b> shown publicly.</p>
        <p><b>What is public.</b> Only your contributions appear in the public library, and, only if you allow it, the display name you chose.</p>
        <p><b>No selling.</b> Your data is neither sold nor handed to third parties for commercial purposes, and never used for advertising.</p>
        <p><b>Your rights.</b> You can request access, correction or deletion of your data at any time by writing to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
        <p><b>Minors.</b> If you are under 18, ask a parent or guardian's permission before contributing.</p>`,
    },
  },
  {
    id: "cgu",
    t: { fr: "Conditions générales d'utilisation", en: "Terms of use" },
    html: {
      fr: `
        <p><b>Objet.</b> Ces conditions régissent l'utilisation de LANGIAL. En utilisant le site, tu les acceptes.</p>
        <p><b>Accès.</b> Consulter la bibliothèque est libre et gratuit. Contribuer (traduire, transcrire, déclarer une langue) demande de créer un profil.</p>
        <p><b>Tes contributions.</b> Tu garantis que tes contributions sont les tiennes ou libres de droits, et exactes au mieux de ta connaissance. En contribuant, tu acceptes qu'elles rejoignent le corpus commun de la langue, consultable et améliorable par la communauté, afin de documenter et d'outiller cette langue (dictionnaires, claviers et, à terme, des outils qui l'apprennent).</p>
        <p><b>Bon usage.</b> Respecte les autres contributeurs. Sont interdits : les contenus injurieux, faux, hors sujet ou détournés de la mission de collecte.</p>
        <p><b>Licence du logiciel.</b> Le code de LANGIAL est publié en logiciel libre, sous licence GNU AGPL v3.</p>
        <p><b>Responsabilité.</b> LANGIAL est fourni « en l'état », sans garantie. Le contenu étant communautaire, il peut comporter des variantes locales ou des erreurs ; il ne saurait engager la responsabilité de l'éditeur.</p>
        <p><b>Évolution.</b> Ces conditions peuvent évoluer ; la version en vigueur est celle affichée sur cette page.</p>`,
      en: `
        <p><b>Purpose.</b> These terms govern the use of LANGIAL. By using the site, you accept them.</p>
        <p><b>Access.</b> Browsing the library is free. Contributing (translating, transcribing, declaring a language) requires creating a profile.</p>
        <p><b>Your contributions.</b> You warrant that your contributions are your own or free of rights, and accurate to the best of your knowledge. By contributing, you agree they join the shared corpus of the language, browsable and improvable by the community, to document and equip that language (dictionaries, keyboards and, in time, tools that learn it).</p>
        <p><b>Fair use.</b> Respect other contributors. The following are forbidden: abusive, false or off-topic content, or any misuse of the collection mission.</p>
        <p><b>Software licence.</b> LANGIAL's code is released as free software, under the GNU AGPL v3 licence.</p>
        <p><b>Liability.</b> LANGIAL is provided "as is", without warranty. As the content is community-driven, it may contain local variants or errors; it cannot engage the publisher's liability.</p>
        <p><b>Changes.</b> These terms may change; the version in force is the one shown on this page.</p>`,
    },
  },
  {
    id: "cgv",
    t: { fr: "Conditions générales de vente", en: "Terms of sale" },
    html: {
      fr: `
        <p>LANGIAL est un service <b>entièrement gratuit</b>. Aucune vente, aucun paiement ni abonnement n'est proposé, et aucune donnée n'est monétisée.</p>
        <p>Il n'existe donc pas, à ce jour, de conditions de vente à proprement parler. Si une offre payante venait un jour à être proposée, des conditions dédiées seraient publiées ici <b>au préalable</b>, et n'auraient aucun effet rétroactif sur les contributions déjà faites.</p>`,
      en: `
        <p>LANGIAL is an <b>entirely free</b> service. No sale, payment or subscription is offered, and no data is monetised.</p>
        <p>There are therefore, to date, no terms of sale as such. Should a paid offer ever be introduced, dedicated terms would be published here <b>beforehand</b>, with no retroactive effect on contributions already made.</p>`,
    },
  },
];

/** Construit le HTML complet de la page légale dans la langue voulue ("fr"|"en"). */
export function legalHtml(lang) {
  const l = lang === "en" ? "en" : "fr";
  return LEGAL_SECTIONS.map((s) =>
    `<section class="legal-sec" id="legal-${s.id}">
       <h3 class="legal-h">${s.t[l]}</h3>
       <div class="legal-body">${s.html[l]}</div>
     </section>`).join("");
}
