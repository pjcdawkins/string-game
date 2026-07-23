/**
 * Diagnostic harness for the bow's high-frequency "squeal" noise (skipped by
 * default — flip `describe.skip` to `describe` and run
 * `npx vitest run test/bowNoiseHarness.test.ts` to use it). Not an assertion
 * suite: it prints measurements for a human to read.
 *
 * Written while investigating the harmonic-y noises heard on top of the main
 * note under touch bowing (much worse on mobile than desktop). Findings, so
 * the numbers here have context:
 *
 * - Under touch-like bowing (velocity wandering and reversing through zero at
 *   60 Hz with pointer jitter), 30 ms windows whose energy is >15% above
 *   2.5 kHz ("squeal windows") are frequent in EVERY variant — including
 *   torsional = 0 / thermal = 0 — so the torsion/thermal additions are not the
 *   primary source.
 * - Squeal windows concentrate sharply at LOW bow speed: roughly half of all
 *   windows at |vBow| < 0.05 squeal, falling to a few percent above 0.14.
 *   Touch strokes linger in that band at every reversal and hesitation, at
 *   undiminished force — the over-pressed corner of the Schelleng diagram —
 *   while the keyboard/auto-bow envelopes are choreographed to sweep through
 *   it quickly. That is the mobile/desktop difference in the model itself.
 * - Steady strokes: the shipped torsional amount brightens some slow, heavy
 *   regimes (vel 0.06 / force 0.45: energy >2 kHz 3.3% -> 5.1%, centroid
 *   600 -> 1040 Hz); elsewhere the effects are neutral-to-darker. Modest.
 * - Whistle capture at ordinary speeds is bimodal run-to-run (the force noise
 *   decides whether a session locks a surface whistle), so single-trial A/B
 *   comparisons of the high-speed bands are unreliable — average many trials
 *   and trust only large differences.
 * - THE MAIN FINDING (held-note probe below): on a note locked at the
 *   fundamental, the 2.5-8 kHz content is 97-99% HARMONIC (a comb on f0 — a
 *   metallic buzz, not noise), and at the slow-heavy corner (vel 0.05, force
 *   0.6, open G) the torsional shunt's original instantaneous scaling made it
 *   BISTABLE: most strokes settled at ~15-19% high-harmonic energy vs a tight
 *   ~3.5% with torsion off; shipped (torsion + thermal) landed in the buzzy
 *   state on a minority of strokes (median clean, upper quartile ~18%).
 *   Cause: post-scaling the excursion by torsFrac only in the slip branch
 *   STEPPED the friction force by (1 − torsFrac)·k·muS at every slip onset
 *   and release — twice per Helmholtz period, a bright harmonic comb.
 *   FIXED by low-passing the torsional reduction (the torsRed one-pole,
 *   TORS_TAU_S in StringSim.ts): after the fix the shipped combination is the
 *   tightest variant at that corner (median 0.62%, IQR 0.61-0.66%), ordinary
 *   strokes are unchanged, the attack corners hold or improve, and the
 *   stopped-unison sympathy ring sits at ~4.1-4.2x its detuned control. Full
 *   write-up in MODEL_NOTES.md ("The torsional reduction is low-passed").
 */
import { describe, it } from "vitest";
import { StringSim } from "../src/audio/dsp/StringSim";

const FS = 48000;

const G_BASE = { f0: 196, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0.35 };

type Variant = { name: string; torsional: number; thermal: number };
const VARIANTS: Variant[] = [
  { name: "off/off  ", torsional: 0, thermal: 0 },
  { name: "tors only", torsional: 0.55, thermal: 0 },
  { name: "thrm only", torsional: 0, thermal: 0.4 },
  { name: "shipped  ", torsional: 0.55, thermal: 0.4 },
];

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Band-energy ratios of buf from `from` seconds (32768-point Hann FFT). */
function spectrum(buf: Float32Array, from: number) {
  const N = 32768;
  const a = Math.round(from * FS);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    re[i] = (buf[a + i] ?? 0) * w;
  }
  fft(re, im);
  const binHz = FS / N;
  let total = 0;
  let above2k = 0;
  let above4k = 0;
  let centroidNum = 0;
  for (let k = 1; k < N / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const f = k * binHz;
    total += p;
    centroidNum += p * f;
    if (f > 2000) above2k += p;
    if (f > 4000) above4k += p;
  }
  return { r2k: above2k / total, r4k: above4k / total, centroid: centroidNum / total };
}

/** One biquad highpass section. */
class HP {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(fc: number, q: number) {
    const w = (2 * Math.PI * fc) / FS;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cw) / 2 / a0;
    this.b1 = -(1 + cw) / a0;
    this.b2 = (1 + cw) / 2 / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  p(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Deterministic jitter source (the sim's own force noise stays stochastic). */
function xorshift(seed: number): () => number {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Steady stroke, keyboard-like: smooth ramp with bite, then constant speed.
 * Length must cover the held-note probe's analysis window entirely: it reads a
 * 65536-point FFT from 0.8 s in (through sample ~103935), so anything shorter
 * would zero-pad the tail of the window and leak into the harmonic-ratio
 * figures. 2.4 s (115200 samples) clears it with margin; the extra tail is
 * steady-state audio, so the numbers are measured over real signal only. */
function renderSteady(v: Variant, vel: number, force: number): Float32Array {
  const sim = new StringSim(FS);
  sim.setString({ ...G_BASE, torsional: v.torsional, thermal: v.thermal });
  sim.bowPosition = 0.88;
  sim.bowOn = true;
  const out = new Float32Array(Math.round(2.4 * FS));
  const frame = Math.round(FS / 30);
  for (let i = 0; i < out.length; i += 128) {
    if (i % frame < 128) {
      const ts = i / FS;
      sim.bowVelocity = vel * Math.min(1, ts / 0.15);
      sim.bowForce = force * (1 + 0.8 * Math.max(0, 1 - ts / 0.25));
    }
    sim.process(out.subarray(i, Math.min(i + 128, out.length)));
  }
  return out;
}

/** Touch-like session: sinusoidal strokes (speed sweeps through zero at each
 * reversal) with 60 Hz pointer jitter, through the input layer's one-pole. */
function renderTouchSession(
  spec: typeof G_BASE & { torsional: number; thermal: number },
  force: number,
  seed: number
): { out: Float32Array; vels: Float32Array } {
  const sim = new StringSim(FS);
  sim.setString(spec);
  sim.bowPosition = 0.88;
  sim.bowOn = true;
  const out = new Float32Array(Math.round(3.0 * FS));
  const vels = new Float32Array(out.length);
  const frame = Math.round(FS / 60);
  const rand = xorshift(seed);
  let bowVel = 0;
  let cur = 0;
  for (let i = 0; i < out.length; i += 128) {
    if (i % frame < 128) {
      const t = i / FS;
      const target = 0.18 * Math.sin(2 * Math.PI * 0.7 * t) * (1 + 0.35 * rand());
      bowVel += (target - bowVel) * Math.min(1, (1 / 60) * 12);
      sim.bowVelocity = bowVel;
      cur = bowVel;
      sim.bowForce = force * (1 + 0.15 * rand());
    }
    sim.process(out.subarray(i, Math.min(i + 128, out.length)));
    for (let k = i; k < Math.min(i + 128, out.length); k++) vels[k] = cur;
  }
  return { out, vels };
}

/** Autocorrelation pitch estimate with parabolic refinement. */
function estimatePitch(buf: Float32Array, from: number, to: number): number {
  const a = Math.round(from * FS);
  const n = Math.round(to * FS) - a;
  const x = buf.subarray(a, a + n);
  const maxLag = Math.floor(FS / 50);
  const minLag = Math.floor(FS / 2000);
  const ac = (lag: number) => {
    let acc = 0;
    for (let i = 0; i + lag < x.length; i++) acc += x[i] * x[i + lag];
    return acc;
  };
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = ac(lag);
    if (r > bestVal) {
      bestVal = r;
      bestLag = lag;
    }
  }
  const rm = ac(bestLag - 1);
  const rp = ac(bestLag + 1);
  const denom = rm - 2 * bestVal + rp;
  const shift = denom !== 0 ? (0.5 * (rm - rp)) / denom : 0;
  return FS / (bestLag + shift);
}

/** Fraction of total energy in the 2.5-8 kHz band that lies on the harmonic
 * comb of the estimated fundamental (65536-point Hann FFT from 0.8 s in). */
function heldNoteHarmonicHi(buf: Float32Array): { f0est: number; harmRatio: number } {
  const f0est = estimatePitch(buf, 0.8, 1.4);
  const N = 65536;
  const a = Math.round(0.8 * FS);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    re[i] = (buf[a + i] ?? 0) * w;
  }
  fft(re, im);
  const binHz = FS / N;
  const isHarm = new Uint8Array(N / 2);
  for (let k = 1; k * f0est < 8000; k++) {
    const c = Math.round((k * f0est) / binHz);
    for (let b = c - 3; b <= c + 3; b++) if (b > 0 && b < N / 2) isHarm[b] = 1;
  }
  let total = 0;
  let harm = 0;
  for (let k = 1; k < N / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const f = k * binHz;
    total += p;
    if (f >= 2500 && f <= 8000 && isHarm[k]) harm += p;
  }
  return { f0est, harmRatio: harm / total };
}

describe.skip("bow-noise diagnostic harness", () => {
  it("steady-stroke spectra by variant", () => {
    for (const vel of [0.06, 0.12, 0.25]) {
      for (const force of [0.3, 0.45]) {
        console.log(`\n--- steady stroke vel=${vel} force=${force} (open G, bow 0.88) ---`);
        for (const v of VARIANTS) {
          const TRIALS = 4;
          let r2k = 0;
          let r4k = 0;
          let cen = 0;
          for (let t = 0; t < TRIALS; t++) {
            const s = spectrum(renderSteady(v, vel, force), 0.7);
            r2k += s.r2k / TRIALS;
            r4k += s.r4k / TRIALS;
            cen += s.centroid / TRIALS;
          }
          console.log(
            `${v.name}  >2k=${(100 * r2k).toFixed(2)}%  >4k=${(100 * r4k).toFixed(2)}%  centroid=${cen.toFixed(0)}Hz`
          );
        }
      }
    }
  }, 120000);

  it("held-note high-harmonic buzz by variant (the metallic comb)", () => {
    for (const [vel, force] of [
      [0.05, 0.6],
      [0.08, 0.4],
      [0.08, 0.6],
      [0.12, 0.6],
    ] as const) {
      console.log(`\n--- held note vel=${vel} force=${force} (open G, bow 0.88) ---`);
      for (const v of VARIANTS) {
        const TRIALS = 15;
        const vals: number[] = [];
        let locked = 0;
        for (let t = 0; t < TRIALS; t++) {
          const s = heldNoteHarmonicHi(renderSteady(v, vel, force));
          if (Math.abs(s.f0est - G_BASE.f0) < 12) {
            locked++;
            vals.push(s.harmRatio);
          }
        }
        vals.sort((a, b) => a - b);
        const q = (p: number) =>
          vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : NaN;
        console.log(
          `${v.name}  harmonic 2.5-8k energy: med=${(100 * q(0.5)).toFixed(2)}%  q25=${(100 * q(0.25)).toFixed(2)}%  q75=${(100 * q(0.75)).toFixed(2)}%  lockedF0=${locked}/${TRIALS}`
        );
      }
    }
  }, 600000);

  it("touch-session squeal windows by |bowVel| band", () => {
    const bands = [0.02, 0.05, 0.09, 0.14, 999];
    const label = ["<0.02", "0.02-0.05", "0.05-0.09", "0.09-0.14", ">0.14"];
    for (const v of VARIANTS) {
      const counts = new Array<number>(5).fill(0);
      const totals = new Array<number>(5).fill(0);
      const TRIALS = 8;
      for (let t = 0; t < TRIALS; t++) {
        const { out, vels } = renderTouchSession(
          { ...G_BASE, torsional: v.torsional, thermal: v.thermal },
          0.45,
          5 + t * 411
        );
        const hp1 = new HP(2500, 0.54);
        const hp2 = new HP(2500, 1.31);
        const win = Math.round(0.03 * FS);
        let tot = 0;
        let hf = 0;
        let vAcc = 0;
        let n = 0;
        for (let i = Math.round(0.3 * FS); i < out.length; i++) {
          const x = out[i];
          const h = hp2.p(hp1.p(x));
          tot += x * x;
          hf += h * h;
          vAcc += Math.abs(vels[i]);
          n++;
          if (n >= win) {
            const speed = vAcc / n;
            let b = bands.length - 1;
            for (let j = 0; j < bands.length; j++)
              if (speed < bands[j]) {
                b = j;
                break;
              }
            totals[b]++;
            if (tot > 1e-9 && hf / tot > 0.15) counts[b]++;
            tot = 0;
            hf = 0;
            vAcc = 0;
            n = 0;
          }
        }
      }
      const line = label.map((l, j) => `${l}: ${counts[j]}/${totals[j]}`).join("  ");
      console.log(`${v.name}  squeal windows (>15% energy above 2.5k) by speed band:  ${line}`);
    }
  }, 300000);
});
