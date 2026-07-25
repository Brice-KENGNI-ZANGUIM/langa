// Clavier virtuel ngiemboon — composant autonome (ES module), édition premium.
// Disposition + métadonnées (phonétique, exemples) dérivées de la source unique
// de vérité (alphabet.data.js, généré depuis data/alphabet_ngiemboon.json).
// Sortie toujours normalisée NFC.
import { NGIEMBOON } from "./alphabet.data.js";

const nfc = (s) => s.normalize("NFC");

export class NgiemboonKeyboard {
  /**
   * @param {HTMLElement} container - hôte où injecter le clavier
   * @param {HTMLTextAreaElement|HTMLInputElement} target - champ cible
   */
  constructor(container, target, alphabet) {
    this.container = container;
    this.target = target;
    // Alphabet PILOTE le clavier (générique) : ngiemboon par défaut, ou tout autre
    // pack de langue de même structure (voyelles, consonnes, tons, disposition_lettres…).
    this.alpha = alphabet || NGIEMBOON;
    this.shift = false;
    this.tipsEnabled = true; // aide phonétique activée par défaut
    this.panel = null;       // zone d'aide phonétique au-dessus du clavier
    // Distinguer un vrai TAP d'un SCROLL : le mouvement du doigt est mesuré au
    // niveau du DOCUMENT (fiable même si le doigt quitte la touche pendant le
    // défilement). Au-delà de 8px de déplacement, ce n'est plus un tap → on
    // n'insère rien. Supprime les lettres parasites au simple survol/scroll.
    this._gesture = null;
    this._onDocPointerMove = (e) => {
      const g = this._gesture;
      if (g && (Math.abs(e.clientX - g.sx) > 8 || Math.abs(e.clientY - g.sy) > 8)) g.moved = true;
    };
    document.addEventListener("pointermove", this._onDocPointerMove, { passive: true });
    this._build();
    this._suppressOSKeyboard(this.target);
  }

  /**
   * Empêche le clavier logiciel du téléphone de s'ouvrir sur le champ ciblé :
   * `inputmode="none"` garde le curseur et la sélection mais supprime le clavier
   * système, pour que SEUL le clavier ngiemboon écrive dans ce champ.
   */
  _suppressOSKeyboard(el) {
    if (!el) return;
    if (el.dataset.imOrig === undefined) el.dataset.imOrig = el.getAttribute("inputmode") || "";
    el.setAttribute("inputmode", "none");
  }

  /** Restaure le clavier système sur un champ qui n'est plus la cible. */
  _restoreOSKeyboard(el) {
    if (!el || el.dataset.imOrig === undefined) return;
    if (el.dataset.imOrig) el.setAttribute("inputmode", el.dataset.imOrig);
    else el.removeAttribute("inputmode");
  }

  /** Active/désactive l'aide phonétique (zone au-dessus du clavier). */
  setTips(on) {
    this.tipsEnabled = !!on;
    this._updatePanelVisibility();
  }

  /** Rattache la zone d'aide phonétique (affichée à la frappe, pas au survol). */
  setPanel(el) {
    this.panel = el;
    this._updatePanelVisibility();
    this._renderPanel(null);
  }

  _updatePanelVisibility() {
    if (this.panel) this.panel.classList.toggle("is-on", !!this.tipsEnabled);
  }

  /** Affiche l'info d'une touche dans la zone d'aide (si activée). */
  _showInfo(info) {
    if (!this.tipsEnabled || !this.panel || !info) return;
    this._renderPanel(info);
  }

  _renderPanel(info) {
    if (!this.panel) return;
    if (!info) {
      this.panel.innerHTML =
        `<span class="tip-empty">Appuie sur une lettre pour voir sa prononciation.</span>`;
      return;
    }
    const ex = info.ex
      ? `<span class="tip-ex"><b>${info.ex}</b><span class="arrow">→</span>${info.ex_fr || ""}</span>`
      : "";
    // « Comment prononcer » en français simple = information PRINCIPALE (le jargon
    // linguistique reste dans la donnée mais n'encombre plus l'aide). L'API et
    // l'exemple viennent en appui, discrets.
    const prononce = info.prononce || info.desc || "";
    this.panel.innerHTML =
      `<span class="tip-glyph">${info.glyph}</span>` +
      (prononce ? `<span class="tip-prononce">${prononce}</span>` : "") +
      (info.ipa ? `<span class="tip-ipa">[${info.ipa}]</span>` : "") +
      ex;
  }

  /** Rattache le clavier à un autre champ de saisie. */
  setTarget(el) {
    if (this.target && this.target !== el) this._restoreOSKeyboard(this.target);
    this.target = el;
    this._suppressOSKeyboard(el);
  }

  // --- Construction du DOM (disposition physique compacte) ----------------
  _build() {
    const kb = document.createElement("div");
    kb.className = "ngk ngk--physique";
    kb.setAttribute("role", "group");
    kb.setAttribute("aria-label", `Clavier ${this.alpha.langue}`);

    // Deux pages : « Lettres » (ngiemboon + tons) par défaut, et « Symboles »
    // (chiffres, accents FR, ponctuation) accessible par une touche de bascule.
    // Sur mobile, une seule page à la fois → clavier deux fois plus court, on
    // voit ce qu'on écrit. Sur ordinateur, les deux pages restent affichées.
    kb.dataset.page = "letters";
    kb.appendChild(this._legend());

    // Variantes accentuées accessibles par appui long (é è ê ë sur « e », etc.)
    this._variants = this._buildVariantMap();
    // Marques combinantes de TON (une seule à la fois sur une voyelle) : sert à
    // remplacer un ton par un autre au lieu de les empiler.
    this._toneMarks = new Set((this.alpha.tons || []).map((t) => t.combinant).filter(Boolean));

    // Recherche des lettres par graphème
    const vowByMin = new Map(this.alpha.voyelles.map((v) => [v.min, v]));
    const consByGraph = new Map(this.alpha.consonnes.map((c) => [c.graph, c]));
    const alphaKey = (g) => {
      if (vowByMin.has(g)) return this._letterKey(vowByMin.get(g), "vow");
      if (consByGraph.has(g)) return this._letterKey(consByGraph.get(g), "cons");
      return this._plainKey(g, "num");
    };

    // === PAGE LETTRES ===
    const pageL = document.createElement("div");
    pageL.className = "ngk__page ngk__page--letters";
    // Rangées de lettres SANS ⇧ (déplacé en rangée basse) : sur mobile, elles
    // fusionnent en une seule grille (display:contents) → lignes pleines, aucun
    // bouton orphelin. Sur ordinateur, elles restent 3 rangées décalées.
    const disp = this.alpha.disposition_lettres || [];
    disp.forEach((row, i) => {
      const keys = row.map(alphaKey);
      const off = i === 1 ? " ngk__krow--off1" : i === 2 ? " ngk__krow--off2" : "";
      pageL.appendChild(this._krow(keys, "ngk__krow--letters" + off));
    });
    const tones = this.alpha.tons.filter((t) => t.marque && t.combinant).map((t) => this._toneKey(t));
    if (tones.length) pageL.appendChild(this._krow(tones, "ngk__krow--tones"));
    // Ponctuation usuelle (. , ? ! ; : - ') RAPATRIÉE sur la page principale :
    // signes très fréquents accessibles sans basculer vers le clavier secondaire.
    const punct = (this.alpha.ponctuation || []).map((p) => this._plainKey(p, "punc"));
    if (punct.length) pageL.appendChild(this._krow(punct, "ngk__krow--punc"));
    kb.appendChild(pageL);

    // === PAGE SYMBOLES (chiffres, accents FR, symboles) ===
    const pageS = document.createElement("div");
    pageS.className = "ngk__page ngk__page--symbols";
    const digits = (this.alpha.chiffres || []).map((d) => this._plainKey(d, "num"));
    if (digits.length) pageS.appendChild(this._krow(digits, "ngk__krow--num"));
    // Les accents FR ne sont plus une rangée ici : ils sont RAPATRIÉS en appui
    // long sur leur voyelle/consonne de base (à â ä sur « a », é è ê ë sur « e »…).
    const symbols = (this.alpha.symboles || []).map((s) => this._plainKey(s, "sym"));
    if (symbols.length) pageS.appendChild(this._krow(symbols, "ngk__krow--sym"));
    kb.appendChild(pageS);

    // === RANGÉE BASSE PARTAGÉE (toujours visible) : ⇧ + bascule + espace + effacer ===
    const shift = this._key("⇧", "ngk__key--action ngk__key--shift ngk__key--fn",
      () => this._toggleShift());
    this._shiftBtn = shift;
    const toSym = this._key("123 é#", "ngk__key--action ngk__key--mode ngk__key--tosym ngk__key--fn",
      () => this._setPage("symbols"), "Chiffres & accents", { toggle: true });
    const toAbc = this._key("ABC", "ngk__key--action ngk__key--mode ngk__key--toabc ngk__key--fn",
      () => this._setPage("letters"), "Lettres", { toggle: true });
    const space = this._key("espace", "ngk__key--action ngk__key--space",
      () => this._insert(" "), "Espace", { repeat: true });
    const back = this._key("⌫", "ngk__key--action ngk__key--fn",
      () => this._backspace(), "Effacer", { repeat: true });
    kb.appendChild(this._krow([shift, toSym, toAbc, space, back], "ngk__krow--bottom"));

    this.container.appendChild(kb);
    this.kb = kb;

    // Aide phonétique : à chaque appui sur une touche porteuse d'info, on met à
    // jour la zone d'aide au-dessus du clavier (au lieu d'une info-bulle au survol).
    kb.addEventListener("pointerdown", (e) => {
      const b = e.target.closest(".ngk__key");
      if (b && b._tipInfo) this._showInfo(b._tipInfo);
    }, true);

    // Dimensionnement FLUIDE : les touches s'ajustent pour que la rangée la plus
    // large tienne dans la largeur disponible (mobile comme ordinateur), bornées
    // entre une taille confortable au doigt et une taille max. Recalcule au
    // redimensionnement (rotation, fenêtre, ouverture du clavier système…).
    this._fit();
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._fit());
      this._ro.observe(this.container);
    }
    this._onResize = () => this._fit();
    window.addEventListener("resize", this._onResize, { passive: true });
    window.addEventListener("orientationchange", this._onResize, { passive: true });
  }

  /** Taille de touche minimale (confort tactile) et maximale (esthétique). */
  _fit() {
    const kb = this.kb;
    if (!kb || !kb.isConnected) return;
    const cs = getComputedStyle(kb);
    const avail = kb.clientWidth
      - (parseFloat(cs.paddingLeft) || 0)
      - (parseFloat(cs.paddingRight) || 0);
    if (avail <= 0) return;

    const MINK = 30, MAXK = 46; // px
    const curK = parseFloat(cs.getPropertyValue("--k")) || 42;

    // Largeur NATURELLE (sur une seule ligne) de la rangée la plus large :
    // somme des largeurs de touches + espaces + décalage éventuel. Cette mesure
    // reste juste même si une rangée s'est déjà repliée (on somme les enfants).
    let maxNatural = 0;
    kb.querySelectorAll(".ngk__krow").forEach((r) => {
      const rs = getComputedStyle(r);
      const gap = parseFloat(rs.gap) || 6;
      const padL = parseFloat(rs.paddingLeft) || 0;
      const n = r.children.length;
      if (!n) return;
      let sum = 0;
      for (const c of r.children) sum += c.getBoundingClientRect().width;
      const natural = sum + gap * (n - 1) + padL;
      if (natural > maxNatural) maxNatural = natural;
    });
    if (maxNatural <= 0) return;

    // On met à l'échelle --k pour que cette rangée tienne pile dans la largeur.
    let k = curK * (avail / maxNatural);
    k = Math.max(MINK, Math.min(MAXK, k));
    kb.style.setProperty("--k", k.toFixed(2) + "px");
  }

  /** Libère les observateurs (si le clavier est détruit/reconstruit). */
  destroy() {
    if (this._ro) { try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
    if (this._onResize) {
      window.removeEventListener("resize", this._onResize);
      window.removeEventListener("orientationchange", this._onResize);
      this._onResize = null;
    }
    // arrête toute répétition en cours et retire les filets globaux
    (this._repeatStops || []).forEach((stop) => {
      stop();
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    });
    this._repeatStops = [];
  }

  _legend() {
    const items = [
      ["vow", "Voyelles"],
      ["cons", "Consonnes"],
      ["special", "Lettres propres"],
      ["tone", "Tons"],
      ["acc", "Accents FR"],
      ["num", "Chiffres"],
      ["punc", "Ponctuation"],
      ["sym", "Symboles"],
    ];
    const l = document.createElement("div");
    l.className = "ngk__legend";
    l.innerHTML = items
      .map(([k, label]) => `<span class="ngk__leg ngk__leg--${k}"><i></i>${label}</span>`)
      .join("");
    return l;
  }

  _krow(keys, extra) {
    const r = document.createElement("div");
    r.className = "ngk__krow" + (extra ? " " + extra : "");
    keys.forEach((k) => r.appendChild(k));
    return r;
  }

  /**
   * Ordonne les consonnes en plaçant d'abord celles qui composent le
   * mot-signature (dans l'ordre du mot, dédupliquées), puis les autres dans
   * l'ordre officiel. Reconnaissance immédiate de la langue.
   */
  _orderConsonnes() {
    const cons = this.alpha.consonnes;
    const word = (this.alpha.mot_signature || "").toLowerCase();
    const byGraph = new Map(cons.map((c) => [c.graph, c]));
    const lead = [];
    const seen = new Set();
    for (const ch of word) {
      const c = byGraph.get(ch);
      if (c && !seen.has(ch)) {
        lead.push(c);
        seen.add(ch);
      }
    }
    const rest = cons.filter((c) => !seen.has(c.graph));
    return [...lead, ...rest];
  }

  _grid(kind, keys) {
    const g = document.createElement("div");
    g.className = `ngk__grid ngk__grid--${kind}`;
    keys.forEach((k) => g.appendChild(k));
    return g;
  }

  _key(label, cls, onClick, aria, opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ngk__key" + (cls ? " " + cls : "");
    b.textContent = label;
    if (aria) b.setAttribute("aria-label", aria);

    // Touches à RÉPÉTITION (⌫ Effacer, espace) : maintenir le doigt efface /
    // insère en continu et de plus en plus vite, au lieu d'un appui par
    // caractère. Délai initial court, puis accélération jusqu'à un plancher.
    if (opts && opts.repeat) {
      let startTimer = null, repeatTimer = null;
      const stop = () => {
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
      };
      const begin = (e) => {
        e.preventDefault();
        stop();
        onClick();                 // action immédiate au 1er contact
        this._refocus();
        // Rythme régulier ~10 caractères/seconde (100 ms) — confortable, pas
        // trop rapide. Courte pause avant de démarrer la répétition.
        const RATE = 100;
        const tick = () => {
          onClick();
          repeatTimer = setTimeout(tick, RATE);
        };
        startTimer = setTimeout(tick, 400);
      };
      b.addEventListener("pointerdown", begin);
      b.addEventListener("pointerup", stop);
      b.addEventListener("pointerleave", stop);
      b.addEventListener("pointercancel", stop);
      // filet de sécurité : relâchement hors de la touche
      window.addEventListener("pointerup", stop, { passive: true });
      window.addEventListener("pointercancel", stop, { passive: true });
      this._repeatStops = this._repeatStops || [];
      this._repeatStops.push(stop);
      return b;
    }

    // Touches de BASCULE de page (123 é# / ABC) : agir sur le CLICK uniquement.
    // Si on basculait dès pointerdown, la touche disparaîtrait (elle est masquée
    // dans l'autre page) et le click suivant tomberait sur la touche opposée
    // apparue au même endroit → double bascule instantanée (bug). En agissant au
    // click, la bascule se produit une seule fois, au relâchement. preventDefault
    // sur pointerdown évite seulement le vol de focus au champ.
    if (opts && opts.toggle) {
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        onClick();
        this._refocus();
      });
      return b;
    }

    // Touches à VARIANTES (voyelles/consonnes accentuables) : appui long → un
    // mini-clavier de variantes apparaît et RESTE affiché. On clique ensuite une
    // variante pour l'insérer, ou ailleurs pour fermer. Un appui court insère la
    // lettre de base.
    if (opts && opts.variants && opts.variants.length) {
      const variants = opts.variants;
      let holdTimer = null, opened = false;
      const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        cancelHold();
        opened = false;
        this._gesture = { key: b, sx: e.clientX, sy: e.clientY, moved: false };
        holdTimer = setTimeout(() => {
          if (this._gesture && this._gesture.moved) return; // le doigt glisse → pas de popup
          opened = true; this._openVariantPopup(b, variants);
        }, 350);
      });
      b.addEventListener("pointerup", (e) => {
        e.preventDefault();
        cancelHold();
        const g = this._gesture; this._gesture = null;
        // Appui long → popup ouvert, rien au relâchement. Appui court immobile
        // sur la même touche → lettre de base. Déplacement (scroll) → rien.
        if (!opened && g && g.key === b && !g.moved) { this._insert(this.shift ? b.dataset.maj : b.dataset.min); this._refocus(); }
      });
      b.addEventListener("pointercancel", () => { cancelHold(); this._gesture = null; });
      return b;
    }

    // Réponse INSTANTANÉE : insertion dès le pointerdown. Le clavier étant
    // désormais ANCRÉ en bas (fixe, hors flux), on ne fait plus défiler la page
    // SUR les touches → plus d'insertion parasite au scroll, on peut donc revenir
    // à la réactivité maximale. preventDefault évite le vol de focus au champ.
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      b._used = true;
      onClick();
      this._refocus();
    });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (b._used) { b._used = false; return; }
      onClick();
      this._refocus();
    });
    return b;
  }

  /** Garde le curseur dans le champ cible sans re-focus inutile. preventScroll
   * évite que le navigateur fasse défiler la page à chaque frappe (source de
   * saccade perçue sur mobile). */
  _refocus() {
    if (this.target && document.activeElement !== this.target) {
      try { this.target.focus({ preventScroll: true }); }
      catch (e) { this.target.focus(); }
    }
  }

  /** Construit la carte { lettre de base → [variantes accentuées] } à partir des
   * accents FR (source unique). à â ä → a · é è ê ë → e · î ï → i · ô ö œ → o ·
   * ù û ü → u · ç → c. Dérivé par décomposition Unicode (+ ligatures œ/æ). */
  _buildVariantMap() {
    const map = {};
    const baseOf = (ch) => {
      if (ch === "œ") return "o";
      if (ch === "æ") return "a";
      const s = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return (s.length === 1 && s !== ch) ? s.toLowerCase() : null;
    };
    for (const a of this.alpha.accents_fr || []) {
      const base = baseOf(a.min);
      if (!base) continue;
      (map[base] = map[base] || []).push({ min: a.min, maj: a.maj });
    }
    return map;
  }

  // --- Popup de variantes (appui long, persistant) -----------------------
  _openVariantPopup(btn, variants) {
    this._closeVariantPopup();
    const pop = document.createElement("div");
    pop.className = "ngk__varpop";
    variants.forEach((v) => {
      const el = document.createElement("div");
      el.className = "ngk__varkey";
      el.textContent = this.shift ? v.maj : v.min;
      // Clic sur une variante → insertion + fermeture.
      el.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._insert(this.shift ? v.maj : v.min);
        this._closeVariantPopup();
        this._refocus();
      });
      pop.appendChild(el);
    });
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - pr.width - 6));
    let top = r.top - pr.height - 8;
    if (top < 6) top = r.bottom + 8; // sous la touche si pas la place au-dessus
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    this._varPopup = pop;

    // Fermeture si on clique AILLEURS que dans le popup (attachée au tour suivant
    // pour ne pas capter le pointerdown en cours qui vient d'ouvrir le popup).
    this._varOutside = (ev) => {
      if (this._varPopup && !this._varPopup.contains(ev.target)) this._closeVariantPopup();
    };
    setTimeout(() => document.addEventListener("pointerdown", this._varOutside, true), 0);
  }

  _closeVariantPopup() {
    if (this._varOutside) {
      document.removeEventListener("pointerdown", this._varOutside, true);
      this._varOutside = null;
    }
    if (this._varPopup) { this._varPopup.remove(); this._varPopup = null; }
  }

  _letterKey(entry, kind) {
    const min = entry.min ?? entry.graph;
    const maj = entry.maj;
    const isNge = kind === "vow" || kind === "cons";
    const cls =
      `ngk__key--${kind}` +
      (isNge ? " ngk__key--nge" : "") +
      (entry.special ? " ngk__key--special" : "");
    const variants = (this._variants && this._variants[min]) || null;
    const b = this._key(this.shift ? maj : min, cls,
      () => this._insert(this.shift ? maj : min),
      null, variants ? { variants } : undefined);
    if (variants) b.classList.add("ngk__key--hasvar");
    b.dataset.min = min;
    b.dataset.maj = maj;
    this._bindTip(b, {
      glyph: min,
      ipa: entry.ipa,
      desc: entry.desc,
      prononce: entry.prononce,
      ex: entry.ex,
      ex_fr: entry.ex_fr,
    });
    return b;
  }

  _plainKey(ch, kind) {
    // touche simple (chiffre / ponctuation) : insertion directe, sans info-bulle
    return this._key(ch, `ngk__key--${kind}`, () => this._insert(ch));
  }

  _toneKey(t) {
    const b = this._key(
      t.exemple,
      "ngk__key--tone",
      () => this._applyTone(t.combinant),
      `Ton ${t.nom} (${t.diacritique})`
    );
    const name = document.createElement("span");
    name.className = "ngk__tone-name";
    name.textContent = t.nom;
    b.appendChild(name);
    this._bindTip(b, {
      glyph: t.exemple,
      ipa: t.ipa,
      desc: `${t.desc} — accent ${t.diacritique}`,
      prononce: t.prononce,
      ex: t.ex,
      ex_fr: t.ex_fr,
    });
    return b;
  }

  _actionRow() {
    const shift = this._key(
      "⇧ Maj",
      "ngk__key--action ngk__key--shift ngk__key--wide",
      () => this._toggleShift()
    );
    this._shiftBtn = shift;
    const space = this._key("espace", "ngk__key--action ngk__key--space", () =>
      this._insert(" ")
    );
    const back = this._key(
      "⌫",
      "ngk__key--action ngk__key--wide",
      () => this._backspace(),
      "Effacer"
    );
    return this._row([shift, space, back]);
  }

  // --- Info-bulle ---------------------------------------------------------
  /** Mémorise l'info phonétique sur la touche ; affichée dans la zone d'aide au
   * moment de l'appui (voir la délégation pointerdown dans _build). */
  _bindTip(btn, info) {
    if (!info.ipa && !info.desc && !info.prononce && !info.ex) return;
    btn._tipInfo = info;
  }

  // --- Comportement -------------------------------------------------------
  _caret() {
    const el = this.target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    return { el, start, end };
  }

  _setValue(value, caret) {
    const el = this.target;
    el.value = value;
    el.selectionStart = el.selectionEnd = caret;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  _insert(str) {
    const { el, start, end } = this._caret();
    const next = nfc(el.value.slice(0, start) + str + el.value.slice(end));
    const caret = nfc(el.value.slice(0, start) + str).length;
    this._setValue(next, caret);
  }

  _applyTone(combinant) {
    const { el, start, end } = this._caret();
    if (start !== end || start === 0) {
      this._insert(combinant);
      return;
    }
    // On décompose (NFD) la partie avant le curseur pour voir les marques déjà
    // posées sur la dernière lettre, et on RETIRE tout ton existant avant
    // d'appliquer le nouveau → un seul ton à la fois (pas d'empilement).
    let before = el.value.slice(0, start).normalize("NFD");
    const after = el.value.slice(start);
    while (before.length && this._toneMarks.has(before[before.length - 1])) {
      before = before.slice(0, -1);
    }
    const next = nfc(before + combinant + after);
    const caret = nfc(before + combinant).length;
    this._setValue(next, caret);
  }

  _backspace() {
    const { el, start, end } = this._caret();
    if (start !== end) {
      const next = nfc(el.value.slice(0, start) + el.value.slice(end));
      this._setValue(next, start);
    } else if (start > 0) {
      const arr = Array.from(el.value.slice(0, start));
      arr.pop();
      const head = arr.join("");
      const next = nfc(head + el.value.slice(start));
      this._setValue(next, head.length);
    }
  }

  /** Bascule entre la page « Lettres » et la page « Symboles » (mobile). */
  _setPage(p) {
    if (!this.kb) return;
    this.kb.dataset.page = p;
    this._fit();
  }

  _toggleShift() {
    this.shift = !this.shift;
    this._shiftBtn.classList.toggle("is-on", this.shift);
    this.kb.querySelectorAll(".ngk__key[data-min]").forEach((b) => {
      b.textContent = this.shift ? b.dataset.maj : b.dataset.min;
    });
  }
}

export default NgiemboonKeyboard;
