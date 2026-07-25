// Fusion / jumelage de langues (LANGIAL) — logique PURE et testable.
//
// Deux personnes qui ne se connaissent pas peuvent déclarer LA MÊME langue sous des
// orthographes ou des régions différentes. Ce module DÉTECTE les couples proches,
// choisit une langue CANONIQUE, et FUSIONNE sans rien perdre (les orthographes de
// l'autre deviennent des alias, régions et pays sont réunis). La FUSION n'est jamais
// automatique : elle est appliquée seulement après confirmation des déclarants
// (géré ailleurs) — ce module ne fait que le calcul. Aucun DOM, aucun réseau.
//
// Auteur : Brice Kengni Zanguim.

import { findSimilarLanguages } from "./langsim.js";

/** Union propre de deux textes courts (région/pays) sans doublon. */
function unionText(a, b) {
  a = (a == null ? "" : String(a)).trim();
  b = (b == null ? "" : String(b)).trim();
  if (!a) return b;
  if (!b) return a;
  if (a.toLowerCase().indexOf(b.toLowerCase()) !== -1) return a;
  if (b.toLowerCase().indexOf(a.toLowerCase()) !== -1) return b;
  return a + " ; " + b;
}

/**
 * Toutes les PAIRES de langues jugées proches (candidates à la fusion).
 * Ignore les langues déjà fusionnées. Renvoie [{ a, b, score }] triées desc, sans doublon.
 */
export function findDuplicatePairs(languages, opts) {
  const o = opts || {};
  const minScore = o.minScore != null ? o.minScore : 0.7;
  const langs = (languages || []).filter((l) => l && l.id && l.nom && !l.fusionnee_dans);
  const pairs = [];
  const seen = new Set();
  for (const a of langs) {
    const hits = findSimilarLanguages(
      { nom: a.nom, autonyme: a.autonyme, alias: a.alias, region: a.region, pays: a.pays, excludeId: a.id },
      langs, { minScore: minScore, limit: 20 });
    for (const h of hits) {
      const key = [a.id, h.lang.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: a, b: h.lang, score: h.score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

/**
 * Choisit la langue CANONIQUE d'une paire : la graine prime ; sinon la plus contribuée ;
 * sinon l'id le plus « petit » (stable et déterministe). Renvoie { canonical, other }.
 */
export function pickCanonical(a, b) {
  if (!a) return { canonical: b, other: a };
  if (!b) return { canonical: a, other: b };
  if (!!a.graine !== !!b.graine) return a.graine ? { canonical: a, other: b } : { canonical: b, other: a };
  const ca = Number(a.nb_contributions || a.contributions || 0);
  const cb = Number(b.nb_contributions || b.contributions || 0);
  if (ca !== cb) return ca > cb ? { canonical: a, other: b } : { canonical: b, other: a };
  return String(a.id) <= String(b.id) ? { canonical: a, other: b } : { canonical: b, other: a };
}

/**
 * Fusionne `otherId` dans `canonicalId`. Renvoie une NOUVELLE liste (pure, pas de mutation) :
 * la canonique récupère les alias (dont le nom/autonyme de l'autre) et l'union région/pays ;
 * l'autre reçoit `fusionnee_dans = canonicalId`. Ne perd aucune donnée.
 */
export function applyMerge(languages, otherId, canonicalId) {
  if (!Array.isArray(languages) || otherId == null || canonicalId == null || otherId === canonicalId) {
    return Array.isArray(languages) ? languages.map((l) => Object.assign({}, l)) : [];
  }
  const langs = languages.map((l) => Object.assign({}, l));
  const canon = langs.find((l) => l && l.id === canonicalId);
  const other = langs.find((l) => l && l.id === otherId);
  if (!canon || !other) return langs;
  const aliasSet = new Set(
    [].concat(canon.alias || [], other.alias || [], [other.nom, other.autonyme])
      .filter(Boolean).map((s) => String(s).trim()).filter(Boolean));
  aliasSet.delete(canon.nom);
  aliasSet.delete(canon.autonyme);
  canon.alias = [...aliasSet].slice(0, 20);
  canon.region = unionText(canon.region, other.region);
  canon.pays = unionText(canon.pays, other.pays);
  other.fusionnee_dans = canon.id;
  return langs;
}

/** Résout un id éventuellement fusionné vers sa langue canonique (suit la chaîne, borné). */
export function resolveCanonicalId(id, languages) {
  const byId = new Map((languages || []).filter((l) => l && l.id).map((l) => [l.id, l]));
  let cur = byId.get(id), guard = 0;
  while (cur && cur.fusionnee_dans && byId.has(cur.fusionnee_dans) && cur.fusionnee_dans !== cur.id && guard++ < 25) {
    cur = byId.get(cur.fusionnee_dans);
  }
  return cur ? cur.id : id;
}

/** Langues « visibles » = non fusionnées (les fusionnées sont masquées, redirigées). */
export function visibleLanguages(languages) {
  return (languages || []).filter((l) => l && l.id && !l.fusionnee_dans);
}
