// Découpe (rognage) d'un enregistrement audio — garder UNE portion, jeter le reste.
//
// Logique PURE et testable : opère sur des échantillons bruts (Float32 par canal) et
// produit un fichier WAV (PCM 16 bits). AUCUNE dépendance navigateur ici (pas d'AudioContext,
// pas de Blob) → la découpe et l'encodage se testent en Node. Le décodage d'un enregistrement
// (blob → échantillons via Web Audio) et l'emballage en Blob vivent côté app.js.
//
// Auteur : Brice Kengni Zanguim.

/** Borne une valeur dans [min, max]. */
function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

/**
 * Rogne des canaux d'échantillons à l'intervalle temporel [startSec, endSec].
 * Renvoie de NOUVEAUX Float32Array (immutable, l'entrée n'est pas modifiée), bornés
 * aux limites valides. Si l'intervalle est vide ou invalide → canaux vides (0 échantillon).
 * @param {Float32Array[]} channels  un tableau par canal
 * @param {number} sampleRate        Hz
 * @param {number} startSec          début de la zone à garder
 * @param {number} endSec            fin de la zone à garder
 * @returns {{channels: Float32Array[], sampleRate: number, durationSec: number}}
 */
export function sliceSamples(channels, sampleRate, startSec, endSec) {
  const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 48000;
  const chans = Array.isArray(channels) ? channels.filter((c) => c && typeof c.length === "number") : [];
  const total = chans.length ? chans[0].length : 0;
  let s = Math.round(clamp(Number(startSec) || 0, 0, total / sr) * sr);
  let e = Math.round(clamp(Number(endSec), 0, total / sr) * sr);
  if (!isFinite(e) || e <= s) { // fin manquante/invalide → jusqu'au bout si début valide, sinon vide
    e = (Number(endSec) === undefined || isNaN(Number(endSec))) ? total : s;
  }
  s = clamp(s, 0, total);
  e = clamp(e, s, total);
  const out = chans.map((c) => c.slice(s, e));
  const len = out.length ? out[0].length : 0;
  return { channels: out, sampleRate: sr, durationSec: len / sr };
}

/**
 * Encode des canaux Float32 en octets WAV PCM 16 bits (little-endian, entrelacé).
 * Renvoie un Uint8Array (l'app l'emballe ensuite dans un Blob « audio/wav »).
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWavBytes(channels, sampleRate) {
  const sr = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : 48000;
  const chans = (Array.isArray(channels) ? channels : []).filter((c) => c && typeof c.length === "number");
  const numCh = Math.max(1, chans.length);
  const frames = chans.length ? chans[0].length : 0;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataLen = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const wr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); wr(8, "WAVE");
  wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);       // PCM
  dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 8 * bytesPerSample, true);
  wr(36, "data"); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const sample = chans[c] ? clamp(chans[c][i] || 0, -1, 1) : 0;
      dv.setInt16(off, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

/**
 * Détecte la zone UTILE en rognant le silence au début et à la fin (amplitude sous un
 * seuil). Utile pour proposer automatiquement les bornes (bruit de porte/radio en dehors
 * de la parole). Renvoie { startSec, endSec }. Si tout est silence → toute la durée.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} threshold   amplitude (0..1) en dessous de laquelle c'est du silence
 * @param {number} padSec      marge de sécurité conservée autour de la zone utile
 */
export function detectSilenceBounds(channels, sampleRate, threshold, padSec) {
  const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 48000;
  const chans = Array.isArray(channels) ? channels.filter((c) => c && typeof c.length === "number") : [];
  const total = chans.length ? chans[0].length : 0;
  const th = Number(threshold) > 0 ? Number(threshold) : 0.02;
  const pad = Number(padSec) >= 0 ? Number(padSec) : 0.05;
  if (!total) return { startSec: 0, endSec: 0 };
  const amp = (i) => { let m = 0; for (let c = 0; c < chans.length; c++) { const v = Math.abs(chans[c][i] || 0); if (v > m) m = v; } return m; };
  let first = -1, last = -1;
  for (let i = 0; i < total; i++) { if (amp(i) > th) { first = i; break; } }
  if (first < 0) return { startSec: 0, endSec: total / sr };   // tout est silence : ne rien rogner
  for (let i = total - 1; i >= 0; i--) { if (amp(i) > th) { last = i; break; } }
  const start = clamp((first / sr) - pad, 0, total / sr);
  const end = clamp((last / sr) + pad, start, total / sr);
  return { startSec: start, endSec: end };
}

/** Durée totale (secondes) d'un jeu de canaux. */
export function samplesDuration(channels, sampleRate) {
  const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 48000;
  const c = Array.isArray(channels) && channels[0] && channels[0].length ? channels[0].length : 0;
  return c / sr;
}
