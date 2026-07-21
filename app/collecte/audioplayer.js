// Lecteur audio SUR-MESURE de LANGIAL — premium, moderne, responsive.
//
// Habille un élément <audio> existant : bouton play/pause à anneau de progression,
// forme d'onde (canvas) dont la partie lue se remplit avec une CRÊTE lumineuse qui
// se propage, minuteur « m:ss / m:ss », volume repliable. Cliquer/glisser sur l'onde
// = se déplacer. 100 % piloté par les évènements du <audio> (aucune dépendance).
//
// Perf (machine modeste) : l'animation de la crête ne tourne QUE pendant la lecture,
// via requestAnimationFrame ; gelée si prefers-reduced-motion. Waveform DÉTERMINISTE
// (dérivée de la source) → aucun décodage audio (lourd + souvent bloqué par CORS).

const REDUCED = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** #rrggbb → [r,g,b]. Sert au dégradé multicolore ANIMÉ (cyan→vert→or qui s'écoule). */
function hex2rgb(h) {
  h = (h || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}
function mixCol(a, b, t) {
  return "rgb(" + Math.round(a[0] + (b[0] - a[0]) * t) + "," +
    Math.round(a[1] + (b[1] - a[1]) * t) + "," + Math.round(a[2] + (b[2] - a[2]) * t) + ")";
}

// Filtre EAU partagé (une seule définition dans le DOM) : feTurbulence + feDisplacementMap
// déforment le cadre du lecteur comme une image vue à travers de l'eau trouble. La turbulence
// s'anime en continu (seed + baseFrequency) ; l'AMPLITUDE de la déformation (scale) est pilotée
// par le son en direct → nulle au silence, marquée dès que le silence est brisé.
let _waterDisp = null, _waterTried = false;
function ensureWaterFilter() {
  if (_waterTried) return _waterDisp;
  _waterTried = true;
  if (typeof document === "undefined" || !document.body) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  svg.innerHTML =
    '<defs><filter id="aplayer-water" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.012 0.038" numOctaves="2" seed="4" result="noise">' +
        '<animate attributeName="seed" values="2;42;2" dur="7s" repeatCount="indefinite"/>' +
        '<animate attributeName="baseFrequency" values="0.012 0.03;0.016 0.052;0.012 0.03" dur="5s" repeatCount="indefinite"/>' +
      "</feTurbulence>" +
      '<feDisplacementMap in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G"/>' +
    "</filter></defs>";
  document.body.appendChild(svg);
  _waterDisp = svg.querySelector("feDisplacementMap");
  return _waterDisp;
}

/** Durée « m:ss » ; renvoie « --:-- » si inconnue/non finie. */
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

/** Hache une chaîne en entier positif (déterministe) — sert de graine à l'onde. */
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Barres de la forme d'onde (0..1), STABLES pour une source donnée. */
function makeBars(seed, n) {
  let s = seed || 1;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
  const bars = [];
  for (let i = 0; i < n; i++) {
    // enveloppe douce (début/fin plus bas) + variation aléatoire stable
    const env = Math.sin((i / (n - 1)) * Math.PI);
    const v = 0.22 + 0.78 * (0.35 * env + 0.65 * rnd());
    bars.push(Math.max(0.12, Math.min(1, v)));
  }
  return bars;
}

const SVG = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l10-6.5a1 1 0 0 0 0-1.74l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/></svg>',
  vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

/**
 * Monte le lecteur sur-mesure autour d'un <audio>.
 * @param {HTMLElement} box  conteneur (recevra l'UI ; l'<audio> est masqué dedans)
 * @param {HTMLAudioElement} audio  élément audio à piloter
 */
export function mountAudioPlayer(box, audio) {
  if (!box || !audio || box.dataset.aplayer) return;
  box.dataset.aplayer = "1";
  audio.removeAttribute("controls");
  audio.classList.add("aplayer-native");

  const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const N = 72;
  // Enveloppe d'amplitude : discrète au départ, REMPLACÉE par les VRAIS pics décodés
  // de l'audio (decodePeaks) → la forme de l'onde reflète le son réel (fort/faible).
  let peaks = new Array(N).fill(0.14);

  const ui = document.createElement("div");
  ui.className = "aplayer";
  ui.innerHTML =
    '<button type="button" class="aplayer-play" aria-label="Lire"><span class="aplayer-ring"></span>' + SVG.play + "</button>" +
    '<div class="aplayer-mid">' +
      '<canvas class="aplayer-wave" role="slider" tabindex="0" aria-label="Position de lecture" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></canvas>' +
      '<div class="aplayer-time"><span class="aplayer-cur">0:00</span><span class="aplayer-sep">/</span><span class="aplayer-dur">--:--</span></div>' +
    "</div>" +
    '<div class="aplayer-vol">' +
      '<button type="button" class="aplayer-mute" aria-label="Couper le son">' + SVG.vol + "</button>" +
      '<input type="range" class="aplayer-volslider" min="0" max="1" step="0.02" value="1" aria-label="Volume">' +
    "</div>";
  box.insertBefore(ui, audio);

  const playBtn = ui.querySelector(".aplayer-play");
  const canvas = ui.querySelector(".aplayer-wave");
  const curEl = ui.querySelector(".aplayer-cur");
  const durEl = ui.querySelector(".aplayer-dur");
  const muteBtn = ui.querySelector(".aplayer-mute");
  const volSlider = ui.querySelector(".aplayer-volslider");
  const ctx = canvas.getContext("2d");
  // Durée pour CALIBRER la barre : on prend la VRAIE durée jouable (audio.duration) dès
  // qu'elle est connue et fiable → le front de lecture atteint 100 % pile à la fin du son
  // (aucune durée « figée » qui ferait s'arrêter le curseur avant la fin). data-audio-dur
  // (mesuré à l'enregistrement) sert seulement de REPLI tant que audio.duration est indispo
  // (WebM/Opus annonce parfois Infinity avant la sonde fixDuration ci-dessous).
  const knownDur = (() => { const v = parseFloat(box.dataset.audioDur); return isFinite(v) && v > 0 ? v / 1000 : 0; })();
  const DUR = () => {
    // Durée MESURÉE à l'enregistrement (data-audio-dur) = la SEULE fiable : le WebM/Opus
    // annonce une `audio.duration` fausse (souvent très supérieure, ex. 32 s pour 6 s, ou
    // Infinity). On la privilégie donc ; `audio.duration` ne sert QU'EN REPLI (audio importé
    // sans durée connue) et bornée pour écarter les valeurs aberrantes.
    if (knownDur > 0) return knownDur;
    const ad = audio.duration;
    return (isFinite(ad) && ad > 0.05 && ad < 24 * 3600) ? ad : 0;
  };

  // --- VRAIS pics d'amplitude (Web Audio) : la forme de l'onde = le son réel -------
  let peaksDone = false;
  async function decodePeaks() {
    if (peaksDone) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const url = audio.currentSrc || audio.src;
    if (!AC || !url) return;
    // On ne décode que ce qui est lisible sans CORS : blob:, data:, ou même origine.
    if (/^https?:/i.test(url) && !url.startsWith(location.origin)) return;
    peaksDone = true;
    try {
      const arr = await (await fetch(url)).arrayBuffer();
      const acx = new AC();
      const audioBuf = await acx.decodeAudioData(arr);
      try { acx.close(); } catch (e) { /* ok */ }
      const data = audioBuf.getChannelData(0);
      const block = Math.max(1, Math.floor(data.length / N));
      const out = []; let mx = 0;
      for (let i = 0; i < N; i++) {
        let m = 0; const s = i * block;
        for (let j = 0; j < block; j++) { const v = Math.abs(data[s + j] || 0); if (v > m) m = v; }
        out.push(m); if (m > mx) mx = m;
      }
      const norm = mx > 0.001 ? mx : 1;
      // Plancher 0.06 = léger « bruit de fond » là où c'est silencieux (jamais tout plat).
      peaks = out.map((v) => Math.max(0.06, Math.min(1, v / norm)));
      draw();
    } catch (e) { peaksDone = false; /* on garde le placeholder */ }
  }

  // --- Analyseur TEMPS RÉEL : l'onde ondule selon le son joué à l'instant ----------
  let analyser = null, analyserData = null, liveAmp = 0, analyserTried = false;
  function setupAnalyser() {
    if (analyserTried) return; analyserTried = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const acx = new AC();
      const srcNode = acx.createMediaElementSource(audio);
      analyser = acx.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7;
      analyserData = new Uint8Array(analyser.fftSize);
      srcNode.connect(analyser); analyser.connect(acx.destination);
      audio._acx = acx;   // gardé en vie
    } catch (e) { analyser = null; }
  }
  function readLive() {
    if (!analyser) { liveAmp = 0; return; }
    analyser.getByteTimeDomainData(analyserData);
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) { const v = (analyserData[i] - 128) / 128; sum += v * v; }
    liveAmp = Math.min(1, Math.sqrt(sum / analyserData.length) * 3.2);
  }
  // Enveloppe interpolée (lisse) à la position t ∈ [0,1].
  function envAt(t) {
    const f = Math.max(0, Math.min(N - 1, t * (N - 1)));
    const i = Math.floor(f), frac = f - i;
    const a = peaks[i], b = peaks[Math.min(N - 1, i + 1)];
    return a + (b - a) * frac;
  }

  let W = 0, H = 0, dpr = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.round(r.width); H = Math.round(r.height);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function progress() {
    if (audio.ended) return 1;                  // fin réelle → front pile à 100 %
    const d = DUR();
    return d > 0 ? Math.min(1, audio.currentTime / d) : 0;
  }

  let wavePhase = 0;
  // Ajoute une BARRE-PILULE (miroir vertical autour du milieu) à un Path2D.
  function addBar(path, cx, halfLen, w) {
    const r = Math.min(w / 2, halfLen);
    const x = cx - w / 2, y = H / 2 - halfLen, h = halfLen * 2;
    if (path.roundRect) { path.roundRect(x, y, w, h, r); return; }
    path.moveTo(x + r, y);
    path.arcTo(x + w, y, x + w, y + h, r); path.arcTo(x + w, y + h, x, y + h, r);
    path.arcTo(x, y + h, x, y, r); path.arcTo(x, y, x + w, y, r); path.closePath();
  }
  // Forme d'onde = BARRES VERTICALES (façon message vocal, réf. _aplayer_light), dimensionnées
  // par les VRAIS pics du son : partie LUE en dégradé cyan→vert→or, partie non lue grisée, front
  // de lecture lumineux. Pas de courbe blanche. Par-dessus, un effet de VIBRATION/MIRAGE qui se
  // PROPAGE le long des barres : une bosse étroite voyage le long de l'onde (des barres statiques,
  // d'autres qui enflent au passage), d'autant plus marquée que le son émis est fort (liveAmp).
  function draw() {
    if (!W || !H) return;
    const p = progress();
    const cyan = cssVar("--cyan", "#22d3ee");
    const green = cssVar("--green", "#34d399");
    const gold = cssVar("--gold", "#e2b56f");
    const midY = H / 2, maxA = H * 0.44, px = p * W;
    ctx.clearRect(0, 0, W, H);
    // fond sombre local (contraste)
    ctx.save(); ctx.fillStyle = "rgba(4,9,15,0.5)"; const bp = new Path2D();
    if (bp.roundRect) bp.roundRect(0, 0, W, H, 10); else bp.rect(0, 0, W, H);
    ctx.fill(bp); ctx.restore();
    // Dégradé MULTICOLORE COMPLEXE qui S'ÉCOULE le long de la progression (comme les ondes
    // lumineuses sortant du téléphone dans la bannière Transcrire) : la palette cyan→vert→or
    // est répétée CYCLES fois sur la largeur et défile doucement (flowOff), sans couture (les
    // deux extrémités retombent sur la même couleur car CYCLES est entier).
    const pal = [hex2rgb(cyan), hex2rgb(green), hex2rgb(gold)];
    const flowOff = (wavePhase * 0.006) % 1, CYCLES = 3;
    const cyc = (v) => { v = ((v % 1) + 1) % 1; const s = v * 3, seg = Math.floor(s) % 3, f = s - Math.floor(s); return mixCol(pal[seg], pal[(seg + 1) % 3], f); };
    const flowGrad = () => { const g = ctx.createLinearGradient(0, 0, W, 0); const NS = 15; for (let i = 0; i <= NS; i++) { const q = i / NS; g.addColorStop(q, cyc(q * CYCLES + flowOff)); } return g; };
    const played = flowGrad();
    const bw = 2.3, step = bw + 2.3, n = Math.max(1, Math.floor((W - 2) / step));  // barres TRÈS DENSES
    // Position de l'ONDE qui se propage (0→1, boucle), et sa largeur (bosse étroite).
    const wavePos = (wavePhase * 0.016) % 1, sig = 0.07;
    const travelAt = (t) => { const dd = Math.min(Math.abs(t - wavePos), 1 - Math.abs(t - wavePos)); return Math.exp(-(dd * dd) / (2 * sig * sig)); };
    for (let i = 0; i < n; i++) {
      const cx = 2 + i * step + step / 2;
      const t = cx / W, e = envAt(t);
      // Onde voyageante : bosse gaussienne (distance circulaire → boucle sans à-coup). Seules les
      // barres sous la bosse enflent/tremblent (au rythme du son) ; les autres restent statiques.
      const travel = travelAt(t);
      const vib = 1 + liveAmp * 1.9 * travel;
      const half = Math.min(maxA, maxA * (0.10 + 0.90 * e) * vib);
      const isPlayed = cx <= px;
      const path = new Path2D(); addBar(path, cx, half, bw);
      ctx.save();
      ctx.fillStyle = isPlayed ? played : "rgba(150,168,186,0.30)";
      if (isPlayed) { ctx.shadowColor = green; ctx.shadowBlur = 3 + 8 * travel; ctx.globalAlpha = 0.9 + 0.1 * travel; }
      ctx.fill(path);
      ctx.restore();
    }
    // ~10 CORDES fines vibrantes PAR-DESSUS les barres : fins filaments néon tressés (fréquences /
    // phases différentes) qui ondulent, ENFLENT et TREMBLENT (mirage) au passage de l'onde et au
    // rythme du son. Aucune corde blanche ; dégradé cyan→vert→or, glow doux.
    ctx.lineCap = "round";
    const grad = flowGrad();   // même dégradé multicolore que les barres, aligné sur la progression
    const STR = 10;
    for (let k = 0; k < STR; k++) {
      const f = 1.6 + k * 0.85, ph = wavePhase * (0.9 + k * 0.05) + k * 1.2, dir = k % 2 ? 1 : -1;
      const ampS = 0.26 + 0.44 * (1 - k / STR);            // faisceau : cordes plus amples au centre
      ctx.beginPath();
      for (let x = 0; x <= W; x += 3) {
        const tt = x / W, e = envAt(tt), travel = travelAt(tt);
        const live = 1 + liveAmp * (0.6 + 1.4 * travel);   // enfle au passage de l'onde + au son
        const mirage = (0.14 + liveAmp * 0.55) * travel * Math.sin(x * 0.55 + wavePhase * 8 + k) * maxA * 0.11; // TREMBLEMENT
        const y = midY + dir * (Math.sin(x * 0.02 * f + ph) * maxA * ampS * e * live + mirage);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = grad;
      ctx.lineWidth = 0.9 + 0.4 * (1 - k / STR);
      ctx.globalAlpha = 0.28 + 0.24 * (1 - k / STR);
      ctx.shadowColor = green; ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
    // Front de lecture : fin trait lumineux
    if (p > 0 && p < 1) {
      ctx.save();
      ctx.shadowColor = cyan; ctx.shadowBlur = 12; ctx.fillStyle = "#eafcff";
      roundRect(ctx, Math.min(W - 3, px - 1.2), 3, 2.4, H - 6, 1.2); ctx.fill();
      ctx.restore();
    }
    canvas.setAttribute("aria-valuenow", Math.round(p * 100));
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  }

  // Effet EAU TROUBLE : tout le cadre du lecteur se déforme comme une image dans l'eau agitée,
  // uniquement quand le SON BRISE LE SILENCE. `mirage` (0..1) monte vite dès qu'un son émerge
  // (attaque) et redescend en douceur dans les blancs (relâche) → la déformation « marque » la
  // rupture du silence sans clignoter. Coupé au repos et sous prefers-reduced-motion (coût nul).
  const waterDisp = ensureWaterFilter();
  let mirage = 0;
  const SILENCE = 0.05;
  function applyWater() {
    if (REDUCED || !waterDisp) return;
    const target = liveAmp > SILENCE ? Math.min(1, (liveAmp - SILENCE) / 0.22) : 0;
    mirage += (target - mirage) * (target > mirage ? 0.34 : 0.07);
    if (mirage > 0.02) {
      waterDisp.setAttribute("scale", (mirage * (3 + liveAmp * 7)).toFixed(2));  // ~0..10 px
      if (ui.style.filter !== "url(#aplayer-water)") ui.style.filter = "url(#aplayer-water)";
    } else if (ui.style.filter) {
      ui.style.filter = "";
    }
  }
  function clearWater() { mirage = 0; if (ui.style.filter) ui.style.filter = ""; }

  let raf = 0;
  function loop() {
    wavePhase += 0.2;
    readLive();
    applyWater();
    draw();
    if (!audio.paused && !audio.ended) raf = requestAnimationFrame(loop);
    else raf = 0;
  }
  function startLoop() { if (!raf && !REDUCED) raf = requestAnimationFrame(loop); }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; clearWater(); draw(); }

  // --- Évènements audio → UI ---
  const syncPlayIcon = () => {
    const playing = !audio.paused && !audio.ended;
    playBtn.innerHTML = '<span class="aplayer-ring"></span>' + (playing ? SVG.pause : SVG.play);
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Lire");
    ui.classList.toggle("is-playing", playing);
  };
  // Durée FIABLE : les enregistrements WebM/Opus (MediaRecorder) annoncent souvent une
  // durée fausse ou Infinity → la barre se remplirait mal (« 18 s » pour 6 s réelles).
  // Parade standard : on saute à la toute fin pour forcer le navigateur à calculer la
  // VRAIE durée, puis on revient à 0. Fait une seule fois, avant toute lecture.
  let _durFixed = false;
  function fixDuration() {
    if (_durFixed) return; _durFixed = true;
    const onProbe = () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.removeEventListener("timeupdate", onProbe);
        try { audio.currentTime = 0; } catch (e) { /* ok */ }
        durEl.textContent = fmtTime(DUR()); draw();
      }
    };
    audio.addEventListener("timeupdate", onProbe);
    try { audio.currentTime = 1e101; } catch (e) { audio.removeEventListener("timeupdate", onProbe); }
  }
  // On ne sonde `audio.duration` QUE lorsqu'aucune durée n'a été MESURÉE à l'enregistrement
  // (audio importé sans data-audio-dur). Sinon la durée mesurée fait foi : sonder un WebM/Opus
  // renvoie souvent une durée fausse (le bug « 32 s pour 6 s ») et perturbe le curseur.
  audio.addEventListener("loadedmetadata", () => { durEl.textContent = fmtTime(DUR()); draw(); if (knownDur === 0) fixDuration(); });
  audio.addEventListener("loadeddata", decodePeaks);   // vrais pics dès que l'audio est chargé
  if (audio.readyState >= 2) decodePeaks();
  audio.addEventListener("durationchange", () => { durEl.textContent = fmtTime(DUR()); draw(); });
  audio.addEventListener("timeupdate", () => { curEl.textContent = fmtTime(audio.currentTime); if (!raf) draw(); });
  audio.addEventListener("play", () => {
    setupAnalyser();
    if (audio._acx && audio._acx.state === "suspended") { try { audio._acx.resume(); } catch (e) { /* ok */ } }
    syncPlayIcon(); startLoop();
  });
  audio.addEventListener("pause", () => { syncPlayIcon(); stopLoop(); });
  audio.addEventListener("ended", () => { syncPlayIcon(); stopLoop(); curEl.textContent = fmtTime(DUR()); });
  if (DUR() > 0) durEl.textContent = fmtTime(DUR());

  // --- Commandes ---
  playBtn.addEventListener("click", () => {
    // Un seul lecteur à la fois : coupe les autres.
    document.querySelectorAll("audio.aplayer-native").forEach((a) => { if (a !== audio) a.pause(); });
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  });
  const seekAt = (clientX) => {
    const r = canvas.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const d = DUR(); if (d > 0) { audio.currentTime = f * d; draw(); }
  };
  let seeking = false;
  canvas.addEventListener("pointerdown", (e) => { seeking = true; canvas.setPointerCapture(e.pointerId); seekAt(e.clientX); });
  canvas.addEventListener("pointermove", (e) => { if (seeking) seekAt(e.clientX); });
  canvas.addEventListener("pointerup", () => { seeking = false; });
  canvas.addEventListener("keydown", (e) => {
    const d = DUR(); if (!d) return;
    if (e.key === "ArrowRight") { audio.currentTime = Math.min(d, audio.currentTime + 2); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 2); e.preventDefault(); }
    else if (e.key === " " || e.key === "Enter") { playBtn.click(); e.preventDefault(); }
  });
  const syncMute = () => { muteBtn.innerHTML = audio.muted || audio.volume === 0 ? SVG.mute : SVG.vol;
    muteBtn.setAttribute("aria-label", audio.muted ? "Rétablir le son" : "Couper le son"); };
  muteBtn.addEventListener("click", () => { audio.muted = !audio.muted; syncMute(); });
  volSlider.addEventListener("input", () => { audio.volume = parseFloat(volSlider.value); audio.muted = audio.volume === 0; syncMute(); });

  // Redimensionnement → onde nette (responsive).
  if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(resize); ro.observe(canvas); }
  else window.addEventListener("resize", resize);
  syncPlayIcon(); syncMute();
  requestAnimationFrame(resize);
}

export default mountAudioPlayer;
