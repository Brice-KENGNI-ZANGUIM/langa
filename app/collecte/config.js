// Configuration de l'application de collecte.
//
// ENDPOINT vide ("")   → serveur local Python (server/collecte_server.py),
//                        données sauvegardées en 4 copies sur ta machine.
// ENDPOINT renseigné    → URL "…/exec" de ton Google Apps Script : les données
//                        arrivent dans ta Google Sheet + tes audios dans ta
//                        Google Drive (gratuit, sans machine allumée).
//
// VILLAGES : liste des villages/quartiers liés aux variantes du ngiemboon,
// proposée au contributeur (+ option « Autre » pour saisir un choix libre).
// Édite librement cette liste (ajoute les quartiers de Bangang, etc.).
export const CONFIG = {
  ENDPOINT: "https://script.google.com/macros/s/AKfycbx_jaNM030YgVI2RIw0p6wY8lXDMztf7xNY3TqX6TkPxxIGCjtuU6jfN0EJVIQ8PvTa/exec",
  INDICATIF_DEFAUT: "+237", // Cameroun
  // Indicatifs téléphoniques (drapeau + pays + code). Cameroun en tête.
  INDICATIFS: [
    { f: "🇨🇲", p: "Cameroun", d: "+237" },
    { f: "🇫🇷", p: "France", d: "+33" },
    { f: "🇧🇪", p: "Belgique", d: "+32" },
    { f: "🇨🇭", p: "Suisse", d: "+41" },
    { f: "🇩🇪", p: "Allemagne", d: "+49" },
    { f: "🇬🇧", p: "Royaume-Uni", d: "+44" },
    { f: "🇺🇸", p: "États-Unis", d: "+1" },
    { f: "🇨🇦", p: "Canada", d: "+1" },
    { f: "🇮🇹", p: "Italie", d: "+39" },
    { f: "🇪🇸", p: "Espagne", d: "+34" },
    { f: "🇳🇱", p: "Pays-Bas", d: "+31" },
    { f: "🇳🇬", p: "Nigéria", d: "+234" },
    { f: "🇬🇦", p: "Gabon", d: "+241" },
    { f: "🇹🇩", p: "Tchad", d: "+235" },
    { f: "🇨🇫", p: "Centrafrique", d: "+236" },
    { f: "🇬🇶", p: "Guinée équatoriale", d: "+240" },
    { f: "🇨🇬", p: "Congo", d: "+242" },
    { f: "🇨🇩", p: "RD Congo", d: "+243" },
    { f: "🇨🇮", p: "Côte d'Ivoire", d: "+225" },
    { f: "🇸🇳", p: "Sénégal", d: "+221" },
    { f: "🇬🇭", p: "Ghana", d: "+233" },
    { f: "🇧🇯", p: "Bénin", d: "+229" },
    { f: "🇹🇬", p: "Togo", d: "+228" },
    { f: "🇧🇫", p: "Burkina Faso", d: "+226" },
    { f: "🇲🇱", p: "Mali", d: "+223" },
    { f: "🇬🇳", p: "Guinée", d: "+224" },
    { f: "🇲🇦", p: "Maroc", d: "+212" },
    { f: "🇩🇿", p: "Algérie", d: "+213" },
    { f: "🇹🇳", p: "Tunisie", d: "+216" },
    { f: "🇿🇦", p: "Afrique du Sud", d: "+27" },
    { f: "🇰🇪", p: "Kenya", d: "+254" },
    { f: "🇨🇳", p: "Chine", d: "+86" },
    { f: "🇦🇪", p: "Émirats arabes unis", d: "+971" },
    { f: "🇧🇷", p: "Brésil", d: "+55" },
    { f: "🇮🇳", p: "Inde", d: "+91" },
    { f: "🇦🇺", p: "Australie", d: "+61" },
  ],
  VILLAGES: [
    // Villages/groupements de l'aire ngiemboon (variantes principales).
    "Bangang",
    "Batcham",
    "Balatchi",
    "Bamougong",
    "Balessing",
    "Batang",
    // — Quartiers/localités du groupement Bangang (source : Wikipédia FR, à affiner
    //    avec la connaissance locale ; la combobox filtre à la frappe + « Autre »
    //    reste disponible pour toute localité manquante). —
    "Babeughang", "Bachio", "Badatchio", "Badengang", "Baghang 1", "Baghang 2",
    "Bakapfong", "Baladjeutsa", "Balepi", "Kofong", "Bameguea", "Bantsiet",
    "Bamela", "Balie", "Balafotio", "Balekeu", "Bamekeng-Mekoup", "Batsepou",
    "Bantsinla", "Bamessa", "Bamboue", "Batsa'a", "Nzemetsuet", "Baletia",
    "Balekouet", "Tchuelekouet 1", "Tchuelekouet 2", "Bamelang", "Bamelio",
    "Bassessa", "Bandengang", "Bankack", "Balewa", "Bangouo", "Fomelie",
    "Kontse", "Mantah", "Mepibea", "Meto", "Njuinla 1", "Bassoh", "Nkop",
    "Balouo", "Bamemba", "Bankouop", "Bambiete", "Bazuintim", "Tomogang 1",
    "Tomogang 2", "Tsopeua", "Nzindong", "Biete", "Zemezong", "Zemtchuet",
  ],
};
