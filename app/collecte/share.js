// Carte partageable d'un mot du dictionnaire — fonction PURE (testable).
// Produit un TEXTE brut (pas de HTML → aucun risque d'injection) prêt à être
// partagé (navigator.share) ou copié dans le presse-papiers.
//
// Auteur : Brice Kengni Zanguim.

/** Nettoie une valeur : chaîne, espaces normalisés, sans retours ligne, bornée. */
function clean(v, max) {
  let s = v === null || v === undefined ? "" : String(v);
  s = s.replace(/\s+/g, " ").trim();
  if (max && s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

/**
 * Construit le texte d'une carte partageable pour une entrée du dictionnaire.
 *   entry     : { source_text, target_text }
 *   langName  : nom de la langue (ex. « Ngiemboon »)
 *   url       : lien optionnel vers l'app
 * Robuste : tolère les champs manquants, borne la longueur, texte brut (anti-XSS).
 */
export function shareCardText(entry, langName, url) {
  const e = entry || {};
  const src = clean(e.source_text, 120);
  const tgt = clean(e.target_text, 120);
  const lang = clean(langName, 40);

  let head;
  if (src && tgt) head = `« ${src} » → « ${tgt} »`;
  else if (src) head = `« ${src} »`;
  else if (tgt) head = `« ${tgt} »`;
  else head = "Un mot de notre langue";
  if (lang) head += ` (${lang})`;

  const lines = [head, "Partagé via LANGA, pour numériser nos langues"];
  const u = clean(url, 200);
  if (u) lines.push(u);
  return lines.join("\n");
}

/** Titre court pour navigator.share (sans le lien). */
export function shareTitle(langName) {
  const lang = clean(langName, 40);
  return lang ? `LANGA · ${lang}` : "LANGA";
}

// ============================================================================
//  Partage du SITE sur les réseaux sociaux (barres disséminées dans l'app).
//  Instagram / TikTok n'exposent AUCUNE URL de partage de lien → couverts par le
//  bouton natif « Partager » (menu système sur mobile) + « Copier le lien ».
// ============================================================================

const NET_SVG = {
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.004c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.02A9.86 9.86 0 0 0 12.04 2zm5.8 14.03c-.24.68-1.2 1.26-1.97 1.42-.53.11-1.22.2-3.55-.76-2.98-1.23-4.9-4.25-5.05-4.45-.15-.2-1.2-1.6-1.2-3.06 0-1.45.76-2.16 1.03-2.46.27-.3.59-.37.79-.37.2 0 .39.002.56.01.18.008.42-.07.66.5.24.58.82 2 .89 2.15.07.15.12.32.02.52-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.6.17.3.76 1.25 1.63 2.02 1.12 1 2.06 1.31 2.36 1.46.3.15.47.12.64-.07.17-.2.74-.86.94-1.16.2-.3.39-.25.66-.15.27.1 1.7.8 1.99.95.29.15.48.22.55.35.07.12.07.72-.17 1.4z"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.52 1.5-3.9 3.78-3.9 1.1 0 2.24.2 2.24.2v2.46H15.2c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.9h-2.34V22c4.78-.79 8.43-4.94 8.43-9.94z"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.53 3h3.2l-7 8 8.23 10.9h-6.44l-5.04-6.6-5.77 6.6H1.5l7.5-8.57L1.05 3h6.6l4.55 6.02L17.53 3zm-1.12 16.94h1.77L7.68 4.86H5.78l10.63 15.08z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.9 4.27l-3.3 15.55c-.24 1.12-.9 1.38-1.84.86l-5.05-3.72-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.15L17.3 6.9c.41-.36-.09-.56-.63-.2L6.4 13.18l-4.98-1.55c-1.08-.34-1.1-1.08.23-1.6L20.5 2.72c.9-.33 1.69.2 1.4 1.55z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.43.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23a3.7 3.7 0 0 1-.9 1.38 3.7 3.7 0 0 1-1.38.9c-.43.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.43-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.43-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.12 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.9 5.9 0 0 0 1.38 2.12 5.9 5.9 0 0 0 2.12 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a6.14 6.14 0 0 0 3.5-3.5c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.12A5.9 5.9 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0z"/><path d="M12 5.84A6.16 6.16 0 1 0 12 18.16 6.16 6.16 0 0 0 12 5.84m0 10.16A4 4 0 1 1 12 8a4 4 0 0 1 0 8z"/><circle cx="18.41" cy="5.59" r="1.44"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zm9.1-5v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10h-4zM8 11h8v2H8z"/></svg>',
};
const NET_LABEL = { whatsapp: "WhatsApp", facebook: "Facebook", x: "X", telegram: "Telegram" };

/** Liens de partage par réseau (chaînes encodées). Fonction pure et testable. */
export function siteShareLinks(url, text) {
  const u = encodeURIComponent(clean(url, 300));
  const t = encodeURIComponent(clean(text, 280));
  const tu = encodeURIComponent(clean(text, 280) + " " + clean(url, 300));
  return {
    whatsapp: `https://wa.me/?text=${tu}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    telegram: `https://t.me/share/url?url=${u}&text=${t}`,
  };
}

/**
 * Monte une barre de partage du site dans `container`.
 * opts = { url, text, title, toast, nets, copyLabel }
 * Ajoute : bouton natif (si dispo) + réseaux à URL directe + « Copier le lien ».
 */
export function mountShareBar(container, opts) {
  if (!container) return;
  const o = opts || {};
  const url = o.url || location.href;
  const text = o.text || "Découvre LANGA et aidons ensemble à numériser nos langues d'Afrique, en texte et en voix";
  const title = o.title || "LANGA";
  const toast = typeof o.toast === "function" ? o.toast : function () {};
  const nets = o.nets || ["whatsapp", "facebook", "x", "telegram"];
  const links = siteShareLinks(url, text);

  const bar = document.createElement("div");
  bar.className = "sharebar";

  if (navigator.share) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "share-btn share-btn--native";
    b.innerHTML = NET_SVG.share + "<span>" + (o.nativeLabel || "Partager") + "</span>";
    b.addEventListener("click", function () {
      navigator.share({ title: title, text: text, url: url }).catch(function () {});
    });
    bar.appendChild(b);
  }

  nets.forEach(function (n) {
    if (!links[n]) return;
    const a = document.createElement("a");
    a.className = "share-ico share-ico--" + n;
    a.href = links[n];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const netName = NET_LABEL[n] || n;
    const lbl = o.shareOnLabel ? o.shareOnLabel.split("{net}").join(netName) : "Partager sur " + netName;
    a.setAttribute("aria-label", lbl);
    a.title = lbl;
    a.innerHTML = NET_SVG[n];
    bar.appendChild(a);
  });

  // Instagram : pas d'URL de partage → on copie le lien, on ouvre Instagram et on
  // explique de le coller (story/bio). Seule façon réelle de « partager sur Instagram ».
  const ig = document.createElement("button");
  ig.type = "button";
  ig.className = "share-ico share-ico--instagram";
  const igLbl = o.shareOnLabel ? o.shareOnLabel.split("{net}").join("Instagram") : "Partager sur Instagram";
  ig.setAttribute("aria-label", igLbl);
  ig.title = igLbl;
  ig.innerHTML = NET_SVG.instagram;
  ig.addEventListener("click", function () {
    const go = function () {
      toast(o.igMsg || "Lien copié. Colle-le dans ta story ou ta bio Instagram.", "ok");
      window.open("https://www.instagram.com/", "_blank", "noopener");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(go).catch(function () { fallbackCopy(url, go, toast); });
    } else {
      fallbackCopy(url, go, toast);
    }
  });
  bar.appendChild(ig);

  const c = document.createElement("button");
  c.type = "button";
  c.className = "share-ico share-ico--copy";
  const clbl = o.copyLabel || "Copier le lien";
  c.setAttribute("aria-label", clbl);
  c.title = clbl;
  c.innerHTML = NET_SVG.copy;
  c.addEventListener("click", function () {
    const done = function () { toast(o.copiedMsg || "Lien copié ✓", "ok"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { fallbackCopy(url, done, toast); });
    } else {
      fallbackCopy(url, done, toast);
    }
  });
  bar.appendChild(c);

  container.innerHTML = "";
  container.appendChild(bar);
}

function fallbackCopy(text, done, toast) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) {
    toast("Copie impossible, copie le lien manuellement", "warn");
  }
}
