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
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<lift version="0.13" producer="LANGIAL">'];
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

/** Entrées → CLDF (Cross-Linguistic Data Formats) : la FormTable CSV standard des
    wordlists comparatives (colonnes de l'ontologie CLDF). Chaque ligne = une forme
    dans la langue reliée à un concept (Parameter_ID dérivé du sens français), avec
    la variété de village, le rôle et l'audio. Directement exploitable par pycldf /
    CLLD. Fonction PURE. */
export function entriesToCLDF(entries, meta) {
  meta = meta || {};
  const langId = meta.langId || "und";
  const header = ["ID", "Language_ID", "Parameter_ID", "Parameter_Gloss", "Form",
    "Variety", "Speaker_Role", "Audio", "Comment"];
  const rows = [header];
  let n = 0;
  for (const e of (entries || [])) {
    const toFr = /2fr$/i.test(e.direction || "");
    const form = (toFr ? e.source_text : e.target_text) || "";
    const gloss = (toFr ? e.target_text : e.source_text) || "";
    if (!String(form).trim()) continue;
    n++;
    const paramId = String(gloss).normalize("NFD").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || ("p" + n);
    rows.push([String(n), langId, paramId, gloss, form, e.variante || "", e.role || "", e.audio_url || "", e.note || ""]);
  }
  return "﻿" + toCSV(rows);   // BOM UTF-8 (Excel + outils lisent les caractères spéciaux)
}

/** Entrées → ELAN (.eaf, XML) : format des annotations time-alignées des linguistes.
    On produit un document avec un tier de TRANSCRIPTION (le mot dans la langue, un par
    annotation) et un tier de GLOSE française en association symbolique. Chaque forme
    reçoit un intervalle temporel séquentiel (le corpus est fait de mots courts, non
    d'un média continu), ce qui donne un fichier VALIDE, ouvrable dans ELAN. PURE. */
export function entriesToELAN(entries, meta) {
  meta = meta || {};
  const lang = xmlEscape(meta.langId || "und");
  const items = (entries || []).map((e) => {
    const toFr = /2fr$/i.test(e.direction || "");
    return { word: (toFr ? e.source_text : e.target_text) || "", gloss: (toFr ? e.target_text : e.source_text) || "" };
  }).filter((x) => String(x.word).trim());
  let date; try { date = new Date().toISOString(); } catch (e) { date = "2026-01-01T00:00:00Z"; }
  const slots = [], trans = [], glosses = [];
  items.forEach((it, i) => {
    const t1 = "ts" + (2 * i + 1), t2 = "ts" + (2 * i + 2), aid = "a" + (i + 1);
    slots.push(`    <TIME_SLOT TIME_SLOT_ID="${t1}" TIME_VALUE="${i * 1000}"/>`);
    slots.push(`    <TIME_SLOT TIME_SLOT_ID="${t2}" TIME_VALUE="${i * 1000 + 800}"/>`);
    trans.push(`      <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${aid}" TIME_SLOT_REF1="${t1}" TIME_SLOT_REF2="${t2}"><ANNOTATION_VALUE>${xmlEscape(it.word)}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
    if (String(it.gloss).trim())
      glosses.push(`      <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="g${i + 1}" ANNOTATION_REF="${aid}"><ANNOTATION_VALUE>${xmlEscape(it.gloss)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ANNOTATION_DOCUMENT AUTHOR="LANGIAL" DATE="${date}" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">`,
    '  <HEADER TIME_UNITS="milliseconds"></HEADER>',
    '  <TIME_ORDER>', slots.join("\n"), '  </TIME_ORDER>',
    `  <TIER TIER_ID="${lang}-transcription" LINGUISTIC_TYPE_REF="transcription">`, trans.join("\n"), '  </TIER>',
    `  <TIER TIER_ID="gloss-fr" LINGUISTIC_TYPE_REF="gloss" PARENT_REF="${lang}-transcription">`, glosses.join("\n"), '  </TIER>',
    '  <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="transcription" TIME_ALIGNABLE="true" GRAPHIC_REFERENCES="false"/>',
    '  <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="gloss" TIME_ALIGNABLE="false" CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false"/>',
    '  <CONSTRAINT STEREOTYPE="Symbolic_Association" DESCRIPTION="Stereotype for a symbolic association between annotations"/>',
    '</ANNOTATION_DOCUMENT>',
  ].join("\n");
}

/** Nom de fichier sûr (sans caractères hostiles au système de fichiers). */
export function exportFilename(langId, ext) {
  const id = String(langId || "langue").normalize("NFD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "langue";
  const e = ({ json: "json", lift: "lift", csv: "csv", cldf: "csv", elan: "eaf" })[ext] || "csv";
  const base = ext === "lift" ? "langa-lexique" : (ext === "cldf" ? "langa-cldf" : (ext === "elan" ? "langa-elan" : "langa-dictionnaire"));
  return `${base}-${id}.${e}`;
}
