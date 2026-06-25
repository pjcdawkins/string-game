/**
 * Compact YIN pitch detector running on the AnalyserNode's time-domain
 * buffer. Used for the HUD tuner readout, so the "measured" pitch is
 * honest — it comes from the actual audio output.
 */

const BUF = new Float32Array(2048);

export function detectPitch(analyser: AnalyserNode, sampleRate: number): number {
  analyser.getFloatTimeDomainData(BUF);
  let energy = 0;
  for (let i = 0; i < BUF.length; i++) energy += BUF[i] * BUF[i];
  if (energy / BUF.length < 1e-7) return 0;

  const minLag = Math.floor(sampleRate / 2200);
  const maxLag = Math.floor(sampleRate / 70);
  const n = BUF.length;
  const d = new Float32Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let acc = 0;
    for (let i = 0; i + tau < n; i++) {
      const diff = BUF[i] - BUF[i + tau];
      acc += diff * diff;
    }
    d[tau] = acc;
  }
  // cumulative-mean normalised difference
  const cmndf = new Float32Array(maxLag + 2);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    runningSum += d[tau];
    cmndf[tau] = runningSum > 0 ? (d[tau] * tau) / runningSum : 1;
  }
  const threshold = 0.15;
  let tauEst = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) return 0;
  // parabolic refinement
  const a = cmndf[tauEst - 1];
  const b = cmndf[tauEst];
  const c = cmndf[tauEst + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return sampleRate / (tauEst + shift);
}
