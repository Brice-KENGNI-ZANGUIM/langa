// Moteur de SIMILARITÉ entre langues — LANGIAL.
//
// But : quand un utilisateur déclare une langue, détecter celles DÉJÀ présentes qui
// lui ressemblent, même écrites différemment (Nguiemboon ≈ Nguiembor ≈ Nguiembow) ou
// décrites par une autre région. On combine PLUSIEURS critères : ressemblance des noms
// (tolérante aux variantes de transcription), chevauchement région/pays, autonyme,
// autres orthographes (alias). Module PUR (aucune dépendance DOM) → testable.
//
// Auteur : Brice Kengni Zanguim.

/** Replie un nom de langue pour rapprocher ses variantes : minuscules, sans accents,
 *  lettres seules, sons proches (ou→u, w→u) et lettres doublées écrasées (oo→o). */
export function foldName(s) {
  let x = (s == null ? "" : String(s)).normalize("NFD").replace(/[̀-ͯ]/g, "");
  x = x.toLowerCase().replace(/[^a-z]/g, "");
  x = x.replace(/ou/g, "u").replace(/w/g, "u");     // « ou » et « w » ≈ même son
  x = x.replace(/(.)\1+/g, "$1");                    // écrase les lettres doublées
  return x;
}

/** Distance d'édition de Levenshtein (itérative). */
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** Similarité de deux noms 0..1 (après repli), tolérante aux variantes d'écriture. */
export function nameSimilarity(a, b) {
  const fa = foldName(a), fb = foldName(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  const maxLen = Math.max(fa.length, fb.length);
  let sim = 1 - lev(fa, fb) / maxLen;
  if (fa.startsWith(fb) || fb.startsWith(fa)) sim = Math.max(sim, 0.82); // variante tronquée/allongée
  return Math.max(0, sim);
}

/** Chevauchement de mots (région / pays) 0..1 — indice de Jaccard sur mots > 2 lettres. */
export function textOverlap(a, b) {
  const toks = (s) => new Set(
    (s == null ? "" : String(s)).normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

/**
 * Cherche les langues existantes proches de la saisie.
 *   query    = { nom, region, pays, autonyme, alias:[...] }
 *   existing = [{ id, nom, autonyme, region, pays, alias:[...] }, …]
 * Renvoie [{ lang, score, nameSim, regionSim, reasons:[] }] triées desc, au-dessus du seuil.
 */
export function findSimilarLanguages(query, existing, opts) {
  const o = opts || {};
  const minScore = o.minScore != null ? o.minScore : 0.5;
  const q = query || {};
  const qNames = [q.nom, q.autonyme].concat(q.alias || []).filter(Boolean);
  if (!qNames.length) return [];
  const qRegion = [q.region, q.pays].filter(Boolean).join(" ");
  const out = [];
  for (const lang of existing || []) {
    if (!lang || !lang.nom) continue;
    if (q.excludeId && lang.id === q.excludeId) continue;
    const lNames = [lang.nom, lang.autonyme].concat(lang.alias || []).filter(Boolean);
    let nameSim = 0;
    for (const a of qNames) for (const b of lNames) nameSim = Math.max(nameSim, nameSimilarity(a, b));
    const lRegion = [lang.region, lang.pays].filter(Boolean).join(" ");
    const regionSim = textOverlap(qRegion, lRegion);
    const strong = nameSim >= 0.68 || (nameSim >= 0.5 && regionSim >= 0.34);
    if (!strong) continue;
    const score = 0.72 * nameSim + 0.28 * regionSim;
    if (score < minScore) continue;
    const reasons = [];
    if (nameSim >= 0.6) reasons.push("nom proche");
    if (regionSim >= 0.34) reasons.push("région ou pays en commun");
    out.push({ lang, score, nameSim, regionSim, reasons });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, o.limit || 4);
}

export default findSimilarLanguages;
