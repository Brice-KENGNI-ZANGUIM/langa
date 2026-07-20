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
  // Durée AUTORITAIRE : la vraie durée (mesurée à l'enregistrement, transmise via
  // data-audio-dur en ms) PRIME sur audio.duration, peu fiable pour le WebM/Opus.
  const knownDur = (() => { const v = parseFloat(box.dataset.audioDur); return isFinite(v) && v > 0 ? v / 1000 : 0; })();
  const DUR = () => (knownDur > 0 ? knownDur : (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0));

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
  // Forme d'onde = ÉGALISEUR de barres-pilules, dégradé africain cyan→vert→or (comme
  // l'onde du téléphone de l'affiche). Barres LUES en dégradé lumineux + halo, barres
  // à venir en sourdine ; réactives au son près du front (liveAmp) + shimmer continu.
  function draw() {
    if (!W || !H) return;
    const p = progress();
    const cyan = cssVar("--cyan", "#22d3ee");
    const green = cssVar("--green", "#34d399");
    const gold = cssVar("--gold", "#e5c07b");
    const muted = cssVar("--muted", "#8b97a6");
    const px = p * W, halfH = H * 0.44;
    ctx.clearRect(0, 0, W, H);
    const BARS = Math.max(48, Math.min(240, Math.floor(W / 2.2)));   // traits FINS et DENSES (vraie forme d'onde)
    const slot = W / BARS, barW = Math.max(1, slot * 0.5);
    const played = new Path2D(), dim = new Path2D();
    for (let i = 0; i < BARS; i++) {
      const cx = (i + 0.5) * slot;
      let a = envAt(cx / W);
      a += Math.sin(cx * 0.06 + wavePhase) * 0.04;                              // shimmer spatial doux
      const near = Math.max(0, 1 - Math.abs(cx - px) / (W * 0.16));
      a += Math.sin(cx * 0.11 + wavePhase * 1.8) * (liveAmp * 0.6 * near);       // vibration réactive au son
      a = Math.max(0.04, Math.min(1, a));
      addBar(cx <= px ? played : dim, cx, a * halfH, barW);
    }
    // Fond local assombri (fait ressortir le néon, comme sur les références).
    ctx.save(); ctx.fillStyle = "rgba(3,7,12,0.5)"; const bp = new Path2D();
    if (bp.roundRect) bp.roundRect(0, 0, W, H, 10); else bp.rect(0, 0, W, H);
    ctx.fill(bp); ctx.restore();
    // Dégradé futuriste RICHE cyan→turquoise→vert→lime→or.
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, "#2fe4ff"); g.addColorStop(0.26, cyan); g.addColorStop(0.52, "#34e6a6");
    g.addColorStop(0.78, "#9be86a"); g.addColorStop(1, gold);
    // 1) barres à venir : colorées et bien VISIBLES (opaques, juste un peu estompées)
    ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = g; ctx.fill(dim); ctx.restore();
    // 2) barres lues : SOLIDES + halo lumineux (aucune transparence), réactif au son
    ctx.save(); ctx.shadowColor = cyan; ctx.shadowBlur = liveAmp > 0.02 ? 16 : 12;
    ctx.fillStyle = g; ctx.fill(played);
    ctx.shadowColor = "#34e6a6"; ctx.shadowBlur = 6; ctx.fill(played);
    ctx.restore();
    // 3) front de lecture : fin trait lumineux
    if (p > 0 && p < 1) {
      ctx.save();
      ctx.shadowColor = cyan; ctx.shadowBlur = 14; ctx.fillStyle = "#eafcff";
      roundRect(ctx, Math.min(W - 3, px - 1.5), 2, 3, H - 4, 1.5); ctx.fill();
      ctx.restore();
    }
    canvas.setAttribute("aria-valuenow", Math.round(p * 100));
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  }

  let raf = 0;
  function loop() {
    wavePhase += 0.2;
    readLive();
    draw();
    if (!audio.paused && !audio.ended) raf = requestAnimationFrame(loop);
    else raf = 0;
  }
  function startLoop() { if (!raf && !REDUCED) raf = requestAnimationFrame(loop); }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; draw(); }

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
        durEl.textContent = fmtTime(audio.duration); draw();
      }
    };
    audio.addEventListener("timeupdate", onProbe);
    try { audio.currentTime = 1e101; } catch (e) { audio.removeEventListener("timeupdate", onProbe); }
  }
  audio.addEventListener("loadedmetadata", () => { durEl.textContent = fmtTime(DUR()); draw(); if (knownDur <= 0) fixDuration(); });
  audio.addEventListener("loadeddata", decodePeaks);   // vrais pics dès que l'audio est chargé
  if (audio.readyState >= 2) decodePeaks();
  audio.addEventListener("durationchange", () => { if (knownDur <= 0 && _durFixed) durEl.textContent = fmtTime(audio.duration); });
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
