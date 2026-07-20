// Journal des bugs — VERSIONNÉ dans le dépôt (source de vérité des statuts).
// Chaque bug : identifiant unique, description, statut, dates (détection /
// résolution) et métadonnées (sévérité, zone, version du correctif).
// Les bugs SIGNALÉS PAR LES UTILISATEURS arrivent en plus et sont triés ici par le
// mainteneur quand ils sont pris en charge / résolus.
//
// Bilingue : chaque champ textuel a sa variante `_en` (titre_en / description_en /
// correctif_en / zone_en), affichée quand la langue d'interface est l'anglais.
//
// statut   : "resolu" | "en_attente"
// severite : "critique" | "majeur" | "mineur"
// Auteur : Brice Kengni Zanguim
export const BUGS = [
  {
    id: "BUG-U-mrtcyz9u-8933", titre: "Notification de demande impossible à ouvrir",
    titre_en: "Request notification could not be opened",
    description: "Une notification indiquant qu'un utilisateur souhaitait une traduction ou une prononciation dans ta langue ne pouvait pas être ouverte : rien ne se passait au clic, impossible d'aller aider la personne.",
    description_en: "A notification saying a user wanted a translation or pronunciation in your language could not be opened: clicking it did nothing, so there was no way to go and help.",
    statut: "resolu", severite: "critique", zone: "Notifications", zone_en: "Notifications",
    detecte_le: "2026-07-20", resolu_le: "2026-07-20", version: "v242",
    correctif: "Chaque notification est désormais cliquable et mène droit là où agir : une demande t'emmène sur la page Traduire ou Transcrire avec le mot déjà en place ; dès que tu réponds, la personne qui avait fait la demande est prévenue automatiquement. Les retours sur tes contributions (votes, améliorations) ouvrent le mot concerné dans la bibliothèque.",
    correctif_en: "Every notification is now clickable and leads straight to where you can act: a request takes you to the Translate or Transcribe page with the word already filled in; as soon as you answer, the person who asked is notified automatically. Feedback on your contributions (votes, improvements) opens the relevant word in the library.",
  },
  {
    id: "BUG-010", titre: "Page vide après changement de langue sur « Mon profil »",
    titre_en: "Blank page after switching language on “My profile”",
    description: "Sur la page « Mon profil », changer la langue (français ↔ anglais) rechargeait la page mais laissait le corps vide ; il fallait cliquer sur un bouton du menu pour réafficher une page.",
    description_en: "On the “My profile” page, switching language (French ↔ English) reloaded the page but left the body blank; you had to click a menu button to show a page again.",
    statut: "resolu", severite: "majeur", zone: "Interface", zone_en: "Interface",
    detecte_le: "2026-07-18", resolu_le: "2026-07-18", version: "v194",
    correctif: "La page affichée « par défaut » au démarrage était le profil, ce qui trompait la protection anti-doublon du menu et empêchait le réaffichage. Corrigé par un état de départ neutre : chaque page se réaffiche correctement après un changement de langue.",
    correctif_en: "The page shown “by default” at startup was the profile, which fooled the navigation's duplicate guard and prevented redisplay. Fixed with a neutral start state: every page redisplays correctly after a language change.",
  },
  {
    id: "BUG-001", titre: "Certains envois ne partaient pas (données)",
    titre_en: "Some sends didn't go through (data)",
    description: "En cliquant sur « Envoyer les données » avec beaucoup de contributions, quelques-unes étaient comptées comme échouées alors qu'elles avaient bien été enregistrées : le résultat de l'envoi était mal interprété.",
    description_en: "When clicking “Send data” with many contributions, a few were counted as failed even though they had been saved: the send result was misread.",
    statut: "resolu", severite: "critique", zone: "Envoi / synchro", zone_en: "Sending / sync",
    detecte_le: "2026-07-12", resolu_le: "2026-07-13", version: "v76",
    correctif: "L'application vérifie désormais ce qui est réellement enregistré et renvoie automatiquement ce qui manque, jusqu'à confirmation ; deux groupes distinguent « envoyés » et « à renvoyer ».",
    correctif_en: "The app now checks what is actually saved and automatically resends what's missing, until confirmation; two groups distinguish “sent” and “to resend”.",
  },
  {
    id: "BUG-002", titre: "Un même mot pouvait être reproposé au même utilisateur",
    titre_en: "The same word could be re-offered to the same user",
    description: "Un item déjà traduit/transcrit par un utilisateur pouvait lui être reproposé (le même mot existait sous plusieurs identifiants, ex. entre « mots » et le dictionnaire).",
    description_en: "An item already translated/transcribed by a user could be re-offered to them (the same word existed under several IDs, e.g. between “words” and the dictionary).",
    statut: "resolu", severite: "majeur", zone: "Propositions", zone_en: "Suggestions",
    detecte_le: "2026-07-13", resolu_le: "2026-07-13", version: "v77",
    correctif: "Anti-répétition par utilisateur, dédup par texte normalisé, reconstruit depuis les contributions réelles. Tirage aléatoire parmi les non-faits.",
    correctif_en: "Per-user anti-repetition, dedup by normalized text, rebuilt from actual contributions. Random pick among the undone.",
  },
  {
    id: "BUG-003", titre: "Micro non détecté sur PC (portable AMD)",
    titre_en: "Microphone not detected on PC (AMD laptop)",
    description: "Sur PC, l'enregistrement audio échoue (« aucun micro détecté ») alors qu'il fonctionne sur mobile. Le micro interne est un micro numérique (DMIC) rattaché au co-processeur audio AMD ; le noyau Linux actuel lie un pilote qui ne l'expose pas.",
    description_en: "On PC, audio recording fails (“no microphone detected”) while it works on mobile. The internal microphone is a digital mic (DMIC) attached to the AMD audio co-processor; the current Linux kernel binds a driver that doesn't expose it.",
    statut: "en_attente", severite: "majeur", zone: "Audio / système", zone_en: "Audio / system",
    detecte_le: "2026-07-13", resolu_le: "", version: "",
    correctif: "En cours : test d'un noyau plus récent qui prend en charge le micro interne. Contournement fiable : micro/casque USB.",
    correctif_en: "In progress: testing a newer kernel that supports the internal microphone. Reliable workaround: USB mic/headset.",
  },
  {
    id: "BUG-004", titre: "Menus déroulants mal positionnés (PC)",
    titre_en: "Dropdown menus misplaced (PC)",
    description: "Sur PC, un menu déroulant (village, rôle…) s'ouvrait ailleurs que sous son champ.",
    description_en: "On PC, a dropdown menu (village, role…) opened somewhere other than under its field.",
    statut: "resolu", severite: "majeur", zone: "Interface", zone_en: "Interface",
    detecte_le: "2026-07-13", resolu_le: "2026-07-13", version: "v70",
    correctif: "Correction de la superposition qui décalait l'ouverture ; le menu s'affiche de nouveau juste sous son champ.",
    correctif_en: "Fixed the overlay that shifted the opening; the menu shows again right under its field.",
  },
  {
    id: "BUG-005", titre: "Clavier ngiemboon s'ouvrait au défilement",
    titre_en: "Ngiemboon keyboard opened on scroll",
    description: "Un simple défilement démarrant sur le champ ouvrait le clavier et pouvait insérer des lettres parasites.",
    description_en: "A simple scroll starting on the field opened the keyboard and could insert stray letters.",
    statut: "resolu", severite: "mineur", zone: "Clavier", zone_en: "Keyboard",
    detecte_le: "2026-07-12", resolu_le: "2026-07-12", version: "v54",
    correctif: "Ouverture au vrai tap uniquement (immobile < 10 px et < 500 ms) ; suivi du mouvement au niveau document.",
    correctif_en: "Opens on a real tap only (still < 10 px and < 500 ms); movement tracked at document level.",
  },
  {
    id: "BUG-008", titre: "Version en retard sur un appareil (cache navigateur)",
    titre_en: "Version behind on a device (browser cache)",
    description: "Après une mise à jour, un appareil pouvait rester sur une ancienne version (ex. mobile en v79 alors que le PC était en v83), obligeant à un rechargement forcé (Ctrl+Shift+R).",
    description_en: "After an update, a device could stay on an old version (e.g. mobile on v79 while the PC was on v83), forcing a hard reload (Ctrl+Shift+R).",
    statut: "resolu", severite: "majeur", zone: "Interface", zone_en: "Interface",
    detecte_le: "2026-07-13", resolu_le: "2026-07-13", version: "v84",
    correctif: "L'application détecte la nouvelle version et propose de l'installer en un clic (bannière « Nouvelle version disponible »), sans rechargement manuel.",
    correctif_en: "The app detects the new version and offers to install it in one click (“New version available” banner), with no manual reload.",
  },
  {
    id: "BUG-007", titre: "Menus déroulants d'Explorer cachés par les cartes",
    titre_en: "Explore dropdowns hidden by the cards",
    description: "Dans « Explorer », un menu déroulant (filtres) était partiellement occulté par les cartes situées en dessous quand il s'ouvrait (superposition).",
    description_en: "In “Explore”, a dropdown (filters) was partly hidden by the cards below when it opened (overlap).",
    statut: "resolu", severite: "majeur", zone: "Interface", zone_en: "Interface",
    detecte_le: "2026-07-13", resolu_le: "2026-07-13", version: "v79",
    correctif: "Le menu s'affiche désormais au premier plan, bien ancré sous son champ, sans être masqué par les cartes, à l'identique sur PC et mobile.",
    correctif_en: "The menu now shows in the foreground, anchored under its field, not hidden by the cards, identically on PC and mobile.",
  },
  {
    id: "BUG-009", titre: "La bannière de mise à jour réapparaissait après la mise à jour",
    titre_en: "The update banner reappeared after updating",
    description: "Après avoir cliqué sur « Mettre à jour », la mise à jour se faisait mais la bannière « Nouvelle version disponible » revenait indéfiniment ; elle ne disparaissait qu'avec un rechargement forcé (Ctrl+Shift+R).",
    description_en: "After clicking “Update”, the update happened but the “New version available” banner came back indefinitely; it only went away with a hard reload (Ctrl+Shift+R).",
    statut: "resolu", severite: "majeur", zone: "Interface / mise à jour", zone_en: "Interface / update",
    detecte_le: "2026-07-13", resolu_le: "2026-07-13", version: "v88",
    correctif: "La mise à jour s'installe correctement du premier coup et la bannière se referme d'elle-même dès que l'application est réellement à jour.",
    correctif_en: "The update installs correctly on the first try and the banner closes on its own as soon as the app is truly up to date.",
  },
  {
    id: "BUG-006", titre: "Audio non réinitialisé au mot suivant",
    titre_en: "Audio not reset on the next word",
    description: "En passant au mot suivant, un audio enregistré mais non sauvegardé pouvait « coller » à la contribution d'après.",
    description_en: "When moving to the next word, a recorded but unsaved audio could “stick” to the following contribution.",
    statut: "resolu", severite: "majeur", zone: "Audio", zone_en: "Audio",
    detecte_le: "2026-07-12", resolu_le: "2026-07-12", version: "v54",
    correctif: "Remise à zéro du travail en cours (texte, note, domaine, audio) à chaque changement de mot ou d'espace.",
    correctif_en: "Resets the work in progress (text, note, domain, audio) on every word or space change.",
  },
  {
    id: "BUG-U-mrmae78s-7670", titre: "Entrée « fantôme » dans Explorer (sans mot, ni audio, ni traduction)",
    titre_en: "“Ghost” entry in Explore (no word, no audio, no translation)",
    description: "Dans Explorer, deux propositions apparaissaient regroupées sans que le mot à transcrire soit indiqué ; en les ouvrant, deux cadres s'affichaient sans bouton d'écoute audio ni traduction. En cause : des contributions vides (ni texte source, ni traduction, ni audio) issues d'un envoi malformé, regroupées sous une clé vide.",
    description_en: "In Explore, two suggestions appeared grouped without the word to transcribe shown; opening them, two frames displayed with no audio play button or translation. Cause: empty contributions (no source text, no translation, no audio) from a malformed send, grouped under an empty key.",
    statut: "resolu", severite: "mineur", zone: "Explorer", zone_en: "Explore",
    detecte_le: "2026-07-15", resolu_le: "2026-07-15", version: "v113",
    correctif: "Explorer ignore désormais toute entrée sans aucun contenu (ni mot, ni traduction, ni audio jouable), et une contribution vide est refusée à l'enregistrement.",
    correctif_en: "Explore now ignores any entry with no content (no word, no translation, no playable audio), and an empty contribution is refused at save time.",
  },
];
