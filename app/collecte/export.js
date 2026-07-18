// Export du dictionnaire (CSV / JSON) — fonctions PURES, testables en isolation.
// Robustesse : échappement CSV strict (guillemets, virgules, retours ligne),
// GARDE anti-injection de formule (cellules commençant par = + - @ dans un tableur),
// unicode préservé (lettres ɓ ɗ ŋ…), champs manquants tolérés.
//
// Auteur : Brice Kengni Zanguim.

/** Échappe une valeur pour une cellule CSV, avec garde anti-injection de formule. */
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  // Anti-injection : un tableur interprète =…, +…, -…, @… (et TAB/CR en tête) comme
  // une FORMULE. On neutralise en préfixant d'une apostrophe (le contenu reste lisible).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // Échappement CSV standard (RFC 4180) : entourer de " si , " CR LF présents ;
  // les " internes sont doublés.
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Assemble des lignes (tableaux de valeurs) en texte CSV (CRLF, RFC 4180). */
export function toCSV(rows) {
  return (rows || []).map((r) => (r || []).map(csvCell).join(",")).join("\r\n");
}

// Colonnes exportées (ordre stable). Clés = champs d'une entrée browse.
const COLS = [
  ["mot_source", "source_text"],
  ["traduction", "target_text"],
  ["sens", "direction"],
  ["variante", "variante"],
  ["role", "role"],
  ["domaine", "domaine"],
  ["note", "note"],
  ["date", "date"],
  ["audio", "audio_url"],
];

/** Entrées du dictionnaire → CSV (avec en-tête + BOM UTF-8 pour Excel). */
export function entriesToCSV(entries) {
  const header = COLS.map((c) => c[0]);
  const rows = [header].concat((entries || []).map((e) => COLS.map((c) => e[c[1]])));
  // BOM UTF-8 : garantit qu'Excel lit correctement les lettres spéciales (ɓ, é…).
  return "﻿" + toCSV(rows);
}

/** Entrées → JSON pretty (uniquement les champs publics utiles). */
export function entriesToJSON(entries, meta) {
  const clean = (entries || []).map((e) => {
    const o = {};
    for (const [k, src] of COLS) {
      const v = e[src];
      if (v !== null && v !== undefined && v !== "") o[k] = v;
    }
    return o;
  });
  return JSON.stringify(Object.assign({}, meta || {}, { entrees: clean }), null, 2);
}

/** Échappe le texte pour un contenu XML (LIFT) : & < > " sont neutralisés. */
export function xmlEscape(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Entrées → LIFT (Lexicon Interchange FormaT, XML) : le standard des lexiques, importable
    dans FLEx / WeSay et les outils de lexicographie. Chaque entrée devient une <entry> dont
    la VEDETTE (lexical-unit) est le mot DANS LA LANGUE (côté non français, déterminé par le
    sens de l'entrée), avec une <gloss> française, l'audio en <pronunciation><media>, et le
    domaine / la variante de village / la note en traits et notes. Fonction PURE. */
export function entriesToLIFT(entries, meta) {
  meta = meta || {};
  const lang = xmlEscape(meta.langId || "und");   // code de la langue (ex. « nge »)
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<lift version="0.13" producer="LANGA">'];
  let n = 0;
  for (const e of (entries || [])) {
    const toFr = /2fr$/i.test(e.direction || "");           // sens X→français : la vedette est la SOURCE
    const word = (toFr ? e.source_text : e.target_text) || "";
    const gloss = (toFr ? e.target_text : e.source_text) || "";
    if (!String(word).trim()) continue;                     // pas de mot dans la langue → hors lexique
    const id = "lx" + (++n);
    let s = `  <entry id="${id}">\n`;
    s += `    <lexical-unit><form lang="${lang}"><text>${xmlEscape(word)}</text></form></lexical-unit>\n`;
    if (e.audio_url && /^(https?:\/\/|data:audio\/)/i.test(e.audio_url))
      s += `    <pronunciation><media href="${xmlEscape(e.audio_url)}"/></pronunciation>\n`;
    s += `    <sense>\n`;
    if (String(gloss).trim()) s += `      <gloss lang="fr"><text>${xmlEscape(gloss)}</text></gloss>\n`;
    if (e.domaine) s += `      <trait name="semantic-domain" value="${xmlEscape(e.domaine)}"/>\n`;
    if (e.variante) s += `      <trait name="variant-village" value="${xmlEscape(e.variante)}"/>\n`;
    if (e.role) s += `      <trait name="speaker-role" value="${xmlEscape(e.role)}"/>\n`;
    if (e.note) s += `      <note><form lang="fr"><text>${xmlEscape(e.note)}</text></form></note>\n`;
    s += `    </sense>\n  </entry>`;
    out.push(s);
  }
  out.push('</lift>');
  return out.join("\n");
}

/** Nom de fichier sûr (sans caractères hostiles au système de fichiers). */
export function exportFilename(langId, ext) {
  const id = String(langId || "langue").normalize("NFD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "langue";
  const e = ({ json: "json", lift: "lift", csv: "csv" })[ext] || "csv";
  const base = e === "lift" ? "langa-lexique" : "langa-dictionnaire";
  return `${base}-${id}.${e}`;
}
