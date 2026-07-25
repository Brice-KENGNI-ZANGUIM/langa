// Moteur de prédiction GÉNÉRIQUE — complétion de mots RÉELS à la frappe, pour
// N'IMPORTE quelle langue à clavier dédié.
//
// Principe (honnête) : on ne propose QUE des mots attestés. La source est
// double et cumulative :
//   1. l'AMORCE de la langue (le `lexicon` du pack, cf. langpacks.js), passée au
//      constructeur ; pour le ngiemboon c'est un lexique validé par le moteur de
//      règles, pour les autres langues il peut être vide au départ ;
//   2. le CORPUS VIVANT : les mots de la langue dans les contributions déjà
//      collectées (Explorer), agrégés avec leur FRÉQUENCE.
// Le lexique grandit donc tout seul à mesure que la communauté contribue.
//
// Séparation moteur / contenu : ce fichier ne connaît AUCUNE langue en dur ; le
// contenu vient du pack. Tout est on-device : aucun appel réseau. Sortie NFC.

const nfc = (s) => (s || "").normalize("NFC");
// Base « sans ton » : on retire les diacritiques de ton (U+0300–U+036F) pour une
// comparaison tolérante (l'utilisateur tape souvent sans poser les tons). Les
// lettres spéciales (ɛ ɔ ŋ ʉ …) NE se décomposent pas → elles sont préservées.
const TONES = /[̀-ͯ]/g;
const baseOf = (s) => nfc(s).normalize("NFD").replace(TONES, "").normalize("NFC").toLowerCase();

export class Predict {
  /** `lexicon` = amorce [{m, fr}] de la langue (pack). Vide = démarre sans amorce
      et apprend uniquement des contributions. */
  constructor(lexicon) {
    // clé = mot NFC → { m, fr, freq, base }
    this._map = new Map();
    // index : 1re lettre de la base → liste de mots (accélère la complétion)
    this._buckets = new Map();
    this.seed(lexicon || []);
  }

  /** Ajoute/renforce un mot. freqInc : poids (amorce = 1, contribution = 1 par occurrence). */
  add(m, fr, freqInc = 1) {
    m = nfc((m || "").trim());
    if (!m || /\s/.test(m)) return;            // un seul mot, sans espace
    const key = m;
    let e = this._map.get(key);
    if (e) {
      e.freq += freqInc;
      if (!e.fr && fr) e.fr = nfc(fr);
      return;
    }
    const base = baseOf(m);
    if (!base) return;
    e = { m, fr: nfc(fr || ""), freq: freqInc, base };
    this._map.set(key, e);
    const b0 = base[0];
    let bucket = this._buckets.get(b0);
    if (!bucket) { bucket = []; this._buckets.set(b0, bucket); }
    bucket.push(e);
  }

  /** Amorce à partir d'une liste [{m, fr}]. */
  seed(list) {
    if (!Array.isArray(list)) return;
    for (const w of list) this.add(w.m, w.fr, 1);
  }

  /**
   * Apprend depuis les entrées collectées (Explorer). On extrait le côté
   * ngiemboon selon la direction (target_text si target_lang==langId, sinon
   * source_text si source_lang==langId), puis on ajoute chaque MOT.
   */
  learnFromEntries(entries, langId) {
    if (!Array.isArray(entries) || !langId) return;
    for (const r of entries) {
      let txt = null;
      if (r.target_lang === langId) txt = r.target_text;
      else if (r.source_lang === langId) txt = r.source_text;
      if (!txt) continue;
      // on n'ajoute que les MOTS (les phrases servent plus tard aux bigrammes) ;
      // ici chaque token isolé alimente le lexique + sa fréquence.
      for (const tok of nfc(txt).split(/\s+/)) {
        const w = tok.replace(/^[^\p{L}ʼ']+|[^\p{L}ʼ']+$/gu, ""); // rogne ponctuation
        if (w) this.add(w, "", 1);
      }
    }
  }

  /**
   * Complète un préfixe. Renvoie jusqu'à n mots RÉELS {m, fr}, classés :
   * préfixe exact d'abord, puis fréquence décroissante, puis longueur croissante.
   * Tolérant aux tons (« nda » propose « ndá », « ndǎg »…).
   */
  complete(prefix, n = 3) {
    const p = nfc((prefix || "").trim());
    if (!p) return [];
    const pb = baseOf(p);
    if (!pb) return [];
    const bucket = this._buckets.get(pb[0]);
    if (!bucket) return [];
    const out = [];
    for (const e of bucket) {
      if (e.base === pb && e.m === p) continue;       // déjà tapé en entier
      const exact = e.m.startsWith(p);                // préfixe exact (tons compris)
      if (exact || e.base.startsWith(pb)) {
        out.push({ e, exact });
      }
    }
    out.sort((a, b) =>
      (b.exact - a.exact) ||
      (b.e.freq - a.e.freq) ||
      (a.e.m.length - b.e.m.length) ||
      a.e.m.localeCompare(b.e.m));
    return out.slice(0, n).map(({ e }) => ({ m: e.m, fr: e.fr }));
  }

  get size() { return this._map.size; }
}

export default Predict;
