import { describe, expect, it } from "vitest";
import { StringSim } from "../src/audio/dsp/StringSim";

const FS = 48000;

function render(sim: StringSim, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * FS));
  for (let i = 0; i < out.length; i += 128) {
    sim.process(out.subarray(i, Math.min(i + 128, out.length)));
  }
  return out;
}

function rms(buf: Float32Array, from: number, to: number): number {
  const a = Math.round(from * FS);
  const b = Math.round(to * FS);
  let acc = 0;
  for (let i = a; i < b; i++) acc += buf[i] * buf[i];
  return Math.sqrt(acc / (b - a));
}

/** Autocorrelation pitch estimate with parabolic interpolation. */
function estimatePitch(buf: Float32Array, from: number, to: number): number {
  const a = Math.round(from * FS);
  const n = Math.round(to * FS) - a;
  const x = buf.subarray(a, a + n);
  const maxLag = Math.floor(FS / 50);
  const minLag = Math.floor(FS / 2000);
  let bestLag = -1;
  let bestVal = -Infinity;
  const r0 = autocorr(x, 0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = autocorr(x, lag);
    if (r > bestVal) {
      bestVal = r;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || bestVal < 0.2 * r0) return 0;
  // refine with neighbours
  const rm = autocorr(x, bestLag - 1);
  const rp = autocorr(x, bestLag + 1);
  const denom = rm - 2 * bestVal + rp;
  const shift = denom !== 0 ? (0.5 * (rm - rp)) / denom : 0;
  return FS / (bestLag + shift);
}

function autocorr(x: Float32Array, lag: number): number {
  let acc = 0;
  for (let i = 0; i + lag < x.length; i++) acc += x[i] * x[i + lag];
  return acc;
}

function expectNoNaN(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) throw new Error(`non-finite sample at ${i}: ${buf[i]}`);
  }
}

describe("StringSim", () => {
  it("plucked open string sounds at f0", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1 });
    sim.bowPosition = 0.85;
    sim.pluck(0.6, 1.2);
    const out = render(sim, 0.8);
    expectNoNaN(out);
    const f = estimatePitch(out, 0.2, 0.6);
    expect(f).toBeGreaterThan(220 * 0.98);
    expect(f).toBeLessThan(220 * 1.02);
  });

  it("pluck decays over time", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.5, stiffness: 0.1 });
    sim.pluck(0.6, 1.2);
    const out = render(sim, 1.6);
    const early = rms(out, 0.05, 0.25);
    const late = rms(out, 1.3, 1.5);
    expect(early).toBeGreaterThan(0.005);
    expect(late).toBeLessThan(early * 0.5);
  });

  it("bowing sustains a tone at f0 (Helmholtz regime)", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1 });
    sim.bowOn = true;
    sim.bowVelocity = 0.2;
    sim.bowForce = 0.5;
    sim.bowPosition = 0.88;
    const out = render(sim, 1.5);
    expectNoNaN(out);
    const mid = rms(out, 0.6, 0.9);
    const late = rms(out, 1.2, 1.5);
    expect(mid).toBeGreaterThan(0.01); // actually sounding
    expect(late).toBeGreaterThan(mid * 0.5); // sustained, not dying away
    const f = estimatePitch(out, 0.8, 1.4);
    expect(f).toBeGreaterThan(220 * 0.97);
    expect(f).toBeLessThan(220 * 1.03);
  });

  it("firm finger stop raises pitch to f0 / (1 - position)", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1 });
    sim.fingerOn = true;
    sim.fingerPosition = 0.25; // quarter of the string from the nut -> perfect fourth
    sim.fingerPressure = 1;
    sim.bowOn = true;
    sim.bowVelocity = 0.2;
    sim.bowForce = 0.5;
    sim.bowPosition = 0.88;
    const out = render(sim, 1.4);
    expectNoNaN(out);
    const expected = 220 / 0.75; // 293.3 Hz
    const f = estimatePitch(out, 0.7, 1.3);
    expect(f).toBeGreaterThan(expected * 0.97);
    expect(f).toBeLessThan(expected * 1.03);
  });

  it("light touch at the midpoint produces the octave harmonic", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.25, loss: 0.3, stiffness: 0.05 });
    sim.fingerOn = true;
    sim.fingerPosition = 0.5;
    sim.fingerPressure = 0.12; // light harmonic touch
    sim.bowPosition = 0.88;
    sim.pluck(0.7, 1.0);
    const out = render(sim, 1.0);
    expectNoNaN(out);
    const f = estimatePitch(out, 0.45, 0.95);
    expect(f).toBeGreaterThan(440 * 0.97);
    expect(f).toBeLessThan(440 * 1.03);
  });

  it("bow position affects spectrum (sul ponticello is brighter)", () => {
    const spectrumCentroid = (pos: number): number => {
      const sim = new StringSim(FS);
      sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1 });
      sim.bodyMix = 0; // compare the raw string signal
      sim.bowOn = true;
      sim.bowVelocity = 0.2;
      sim.bowForce = 0.5;
      sim.bowPosition = pos;
      const out = render(sim, 1.2);
      // crude spectral centroid via zero-crossing-weighted derivative energy
      let num = 0;
      let den = 0;
      const a = Math.round(0.6 * FS);
      for (let i = a + 1; i < out.length; i++) {
        const d = out[i] - out[i - 1];
        num += d * d;
        den += out[i] * out[i];
      }
      return num / Math.max(1e-12, den);
    };
    const pont = spectrumCentroid(0.96);
    const tasto = spectrumCentroid(0.7);
    expect(pont).toBeGreaterThan(tasto * 1.15);
  });

  it("stays silent and finite with no excitation", () => {
    const sim = new StringSim(FS);
    const out = render(sim, 0.3);
    expectNoNaN(out);
    expect(rms(out, 0.1, 0.3)).toBeLessThan(1e-6);
  });
});
