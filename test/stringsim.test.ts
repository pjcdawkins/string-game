import { describe, expect, it } from "vitest";
import { StringSim } from "../src/audio/dsp/StringSim";
import { FINGER_RADIUS } from "../src/state";

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
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1, nonlinearity: 0 });
    sim.bowPosition = 0.85;
    sim.pluck(0.6, 1.2);
    const out = render(sim, 0.8);
    expectNoNaN(out);
    const f = estimatePitch(out, 0.2, 0.6);
    expect(f).toBeGreaterThan(220 * 0.98);
    expect(f).toBeLessThan(220 * 1.02);
  });

  it("low-string pluck is boosted to at least match a high string (loudness tilt)", () => {
    // a low pizz carries as much energy as a high one but reads far quieter to
    // the ear; the low-frequency tilt lifts it so raw levels favour the low
    // string. Same force, same darkness/loss — only f0 differs.
    const base = { darkness: 0.3, loss: 0.3, stiffness: 0.1, nonlinearity: 0 };
    const low = new StringSim(FS);
    low.setString({ ...base, f0: 196 }); // open G
    low.bowPosition = 0.85;
    low.pluck(0.6, 1.2);
    const lowRms = rms(render(low, 0.4), 0.02, 0.2);

    const high = new StringSim(FS);
    high.setString({ ...base, f0: 659 }); // open E (the tilt's anchor: no boost)
    high.bowPosition = 0.85;
    high.pluck(0.6, 1.2);
    const highRms = rms(render(high, 0.4), 0.02, 0.2);

    expect(lowRms).toBeGreaterThan(highRms);
  });

  it("pluck decays over time", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.5, stiffness: 0.1, nonlinearity: 0 });
    sim.pluck(0.6, 1.2);
    const out = render(sim, 1.6);
    const early = rms(out, 0.05, 0.25);
    const late = rms(out, 1.3, 1.5);
    expect(early).toBeGreaterThan(0.005);
    expect(late).toBeLessThan(early * 0.5);
  });

  it("bowing sustains a tone at f0 (Helmholtz regime)", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1, nonlinearity: 0 });
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
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1, nonlinearity: 0 });
    sim.fingerOn = true;
    // centre the fingertip so its bridge-side edge (the node) lands a quarter of
    // the string from the nut -> perfect fourth
    sim.fingerPosition = 0.25 - FINGER_RADIUS;
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

  it("a firm finger at the nut sounds the open string, not sharp", () => {
    // regression: dragging a pressed finger up onto the nut should release
    // into the fully open string (f0), not terminate a hair short and play
    // slightly sharp
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1, nonlinearity: 0 });
    sim.fingerOn = true;
    sim.fingerPosition = -FINGER_RADIUS; // fingertip slid up onto the nut -> open string
    sim.fingerPressure = 1;
    sim.bowOn = true;
    sim.bowVelocity = 0.2;
    sim.bowForce = 0.5;
    sim.bowPosition = 0.88;
    const out = render(sim, 1.4);
    expectNoNaN(out);
    const f = estimatePitch(out, 0.7, 1.3);
    expect(f).toBeGreaterThan(220 * 0.99);
    expect(f).toBeLessThan(220 * 1.01);
  });

  it("a stop dragged past the fingerboard end keeps raising the pitch", () => {
    // regression: the terminating node used to be clamped at 0.85 (~the board's
    // end), so dragging a firm stop on toward the bridge froze the pitch. A real
    // string keeps climbing up here. The pitch is well above the autocorrelation
    // estimator's ceiling, so assert on the fundamental implied by the speaking
    // length (getState().freq = f0 / (1 - node) for a firm stop) — the quantity
    // the old clamp pinned — while still checking the string genuinely sounds.
    const soundAtNode = (node: number): { freq: number; rms: number } => {
      const sim = new StringSim(FS);
      sim.setString({ f0: 196, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0 });
      sim.fingerOn = true;
      sim.fingerPosition = node - FINGER_RADIUS;
      sim.fingerPressure = 1;
      sim.bowOn = true;
      sim.bowVelocity = 0.2;
      sim.bowForce = 0.55;
      sim.bowPosition = 0.96;
      const out = render(sim, 0.8);
      expectNoNaN(out);
      return { freq: sim.getState().freq, rms: rms(out, 0.4, 0.75) };
    };
    const atCap = soundAtNode(0.85); // the old ceiling
    const beyond = soundAtNode(0.92); // well past the board's end
    // f0/(1-node): 196/0.15 ≈ 1307 Hz at the cap, 196/0.08 ≈ 2450 Hz past it
    expect(atCap.freq).toBeGreaterThan((196 / 0.15) * 0.95);
    expect(atCap.freq).toBeLessThan((196 / 0.15) * 1.05);
    expect(beyond.freq).toBeGreaterThan(atCap.freq * 1.3); // pitch really climbs
    expect(beyond.rms).toBeGreaterThan(0.01); // and still sounds up there
  });

  it("light touch at the midpoint produces the octave harmonic", () => {
    const sim = new StringSim(FS);
    sim.setString({ f0: 220, darkness: 0.25, loss: 0.3, stiffness: 0.05, nonlinearity: 0 });
    sim.fingerOn = true;
    // a light touch damps under the finger's *middle* (unlike a firm stop,
    // which speaks from the patch edge), so centre the fingertip on the node
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
    // each contact point gets a force a player would use there: ponticello
    // takes more weight, sul tasto a light bow (otherwise the tasto stroke
    // exceeds its maximum-bow-force limit and goes raucous-bright)
    const spectrumCentroid = (pos: number, force: number): number => {
      const sim = new StringSim(FS);
      sim.setString({ f0: 220, darkness: 0.3, loss: 0.3, stiffness: 0.1, nonlinearity: 0 });
      sim.bodyMix = 0; // compare the raw string signal
      sim.bowOn = true;
      sim.bowPosition = pos;
      sim.bowForce = force;
      const out = new Float32Array(Math.round(1.4 * FS));
      let t = 0;
      for (let i = 0; i + 128 <= out.length; i += 128) {
        t += 128 / FS;
        sim.bowVelocity = 0.2 * Math.min(1, t / 0.12); // gentle attack
        sim.process(out.subarray(i, i + 128));
      }
      // crude spectral centroid via zero-crossing-weighted derivative energy
      let num = 0;
      let den = 0;
      const a = Math.round(0.7 * FS);
      for (let i = a + 1; i < out.length; i++) {
        const d = out[i] - out[i - 1];
        num += d * d;
        den += out[i] * out[i];
      }
      return num / Math.max(1e-12, den);
    };
    const pont = spectrumCentroid(0.94, 0.6);
    const tasto = spectrumCentroid(0.62, 0.25); // over the fingerboard
    expect(pont).toBeGreaterThan(tasto * 2.0);
  });

  it("a finite bow-hair width suppresses double-slip (octave capture)", () => {
    // A ribbon of hair averages the string velocity the friction curve sees
    // across the contact patch, spreading the moment of slip and starving the
    // secondary slip-within-a-period that captures the octave. At a stop two-
    // thirds up the G string, bowed steadily over the fingerboard, a point
    // contact (bowHairWidth = 0) locks into the octave; the ribbon pulls it
    // back toward the stopped fundamental. Measured as the octave partial's
    // share of the energy at the fundamental + its octave (Goertzel), averaged
    // over a few strokes to smooth the friction model's force noise.
    const goertzel = (buf: Float32Array, f: number, from: number, to: number): number => {
      const a = Math.round(from * FS);
      const b = Math.round(to * FS);
      const w = (2 * Math.PI * f) / FS;
      const cw = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (let i = a; i < b; i++) {
        const s0 = buf[i] + cw * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return s1 * s1 + s2 * s2 - cw * s1 * s2;
    };
    const octaveShare = (width: number): number => {
      const node = 0.7;
      const f0 = 196;
      const sounding = f0 / (1 - node); // ~653 Hz
      let acc = 0;
      const strokes = 4;
      for (let k = 0; k < strokes; k++) {
        const sim = new StringSim(FS);
        sim.setString({ f0, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0 });
        sim.bowHairWidth = width;
        sim.fingerOn = true;
        sim.fingerPosition = node - FINGER_RADIUS;
        sim.fingerPressure = 1;
        sim.bowOn = true;
        sim.bowVelocity = 0.2;
        sim.bowForce = 0.55;
        sim.bowPosition = 0.83;
        const out = render(sim, 0.8);
        expectNoNaN(out);
        const pf = goertzel(out, sounding, 0.4, 0.75);
        const po = goertzel(out, 2 * sounding, 0.4, 0.75);
        acc += po / (pf + po + 1e-20);
      }
      return acc / strokes;
    };
    const point = octaveShare(0); // classic single-point friction (the default)
    const ribbon = octaveShare(0.06); // hair laid flat (the "Hair" slider well up)
    expect(point).toBeGreaterThan(0.55); // point contact locks the octave in
    expect(ribbon).toBeLessThan(point - 0.08); // flattening the hair suppresses it
  });

  it("stays in tune when bowing very close to the bridge", () => {
    // regression: the bridge-side delay segment used to hit its minimum
    // length near the bridge, lengthening the loop and playing flat
    const sim = new StringSim(FS);
    sim.setString({ f0: 440, darkness: 0.28, loss: 0.3, stiffness: 0.15, nonlinearity: 0 });
    sim.bowOn = true;
    sim.bowVelocity = 0.18;
    sim.bowForce = 0.6;
    sim.bowPosition = 0.97; // extreme sul ponticello
    const out = render(sim, 1.4);
    expectNoNaN(out);
    const f = estimatePitch(out, 0.8, 1.3);
    expect(f).toBeGreaterThan(440 * 0.99);
    expect(f).toBeLessThan(440 * 1.01);
  });

  it("tension modulation sharpens loud playing on a nonlinear string", () => {
    const pitchWith = (nl: number): number => {
      const sim = new StringSim(FS);
      sim.setString({ f0: 196, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: nl });
      sim.bowOn = true;
      sim.bowVelocity = 0.4; // fast bow
      sim.bowForce = 0.5;
      sim.bowPosition = 0.7; // sul tasto
      const out = render(sim, 1.4);
      expectNoNaN(out);
      return estimatePitch(out, 0.8, 1.35);
    };
    const linear = pitchWith(0);
    const nonlinear = pitchWith(0.5);
    const cents = 1200 * Math.log2(nonlinear / linear);
    expect(cents).toBeGreaterThan(3); // audibly sharp...
    expect(cents).toBeLessThan(40); // ...but not absurdly so
  });

  it("stays silent and finite with no excitation", () => {
    const sim = new StringSim(FS);
    const out = render(sim, 0.3);
    expectNoNaN(out);
    expect(rms(out, 0.1, 0.3)).toBeLessThan(1e-6);
  });

  describe("lossy torsional shunt at the bow", () => {
    const base = { f0: 196, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0.35 };

    // A sustained bowed stroke, reaching model speed 0.3 at the given force and
    // contact, with a gentle 120 ms attack. `spec` carries the torsional value
    // (or omits it). Returns the raw string signal.
    const bowedSpec = (spec: object, speed: number, force: number, pos: number, secs = 1.5): Float32Array => {
      const sim = new StringSim(FS);
      sim.setString(spec as Parameters<StringSim["setString"]>[0]);
      sim.bodyMix = 0;
      sim.bowOn = true;
      sim.bowPosition = pos;
      sim.bowForce = force;
      const out = new Float32Array(Math.round(secs * FS));
      let t = 0;
      for (let i = 0; i + 128 <= out.length; i += 128) {
        t += 128 / FS;
        sim.bowVelocity = speed * Math.min(1, t / 0.12);
        sim.process(out.subarray(i, i + 128));
      }
      return out;
    };
    const bowed = (torsional: number, speed: number, force: number, pos: number, secs = 1.5): Float32Array =>
      bowedSpec({ ...base, torsional }, speed, force, pos, secs);
    // mean steady RMS over several strokes — the friction noise makes any one
    // stroke's level vary ~±20%, so the invariants below average it out
    const meanLevel = (torsional: number, n = 5): number => {
      let s = 0;
      for (let i = 0; i < n; i++) s += rms(bowed(torsional, 0.3, 0.5, 0.85), 0.6, 1.1);
      return s / n;
    };

    it("torsional = 0 is the pure-transverse bow (same as omitting it)", () => {
      // the field defaults to 0; with it explicitly 0 the friction path is
      // byte-for-byte the no-field case. Pin the friction noise to a fixed
      // sequence so the two strokes are directly comparable, and assert they
      // are identical (not merely close) — torsional = 0 must change nothing.
      const orig = Math.random;
      const seeded = () => {
        let s = 0x2545f491;
        return () => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s / 0x7fffffff;
        };
      };
      let withZero: Float32Array;
      let omitted: Float32Array;
      try {
        Math.random = seeded();
        withZero = bowedSpec({ ...base, torsional: 0 }, 0.3, 0.5, 0.85);
        Math.random = seeded();
        omitted = bowedSpec({ ...base }, 0.3, 0.5, 0.85);
      } finally {
        Math.random = orig;
      }
      let maxDiff = 0;
      for (let i = 0; i < withZero.length; i++) maxDiff = Math.max(maxDiff, Math.abs(withZero[i] - omitted[i]));
      expect(maxDiff).toBe(0);
    });

    it("sustains Helmholtz at f0 with the shunt engaged", () => {
      const out = bowed(0.55, 0.3, 0.5, 0.85);
      expectNoNaN(out);
      const f = estimatePitch(out, 0.8, 1.4);
      expect(f).toBeGreaterThan(196 * 0.97);
      expect(f).toBeLessThan(196 * 1.03);
      // a slip-only loss must not choke the tone nor pump it up: the mean
      // shunted level stays a healthy fraction of the pure-transverse one
      const shunted = meanLevel(0.55);
      const plain = meanLevel(0);
      expect(shunted).toBeGreaterThan(plain * 0.6);
      expect(shunted).toBeLessThan(plain * 1.4);
    });

    it("leaves the stick-dominated extremes intact (slow bow, over-pressure)", () => {
      // the shunt acts only during slip, so these stick-heavy regimes must
      // still speak with it fully engaged — not choke to silence
      const slow = bowed(0.55, 0.06, 0.4, 0.85, 1.6);
      expectNoNaN(slow);
      expect(rms(slow, 0.9, 1.5)).toBeGreaterThan(0.02);

      const heavy = bowed(0.55, 0.3, 1.4, 0.85, 1.5); // crushing over-pressure
      expectNoNaN(heavy);
      expect(rms(heavy, 0.8, 1.4)).toBeGreaterThan(0.05);
    });

    it("keeps sul ponticello brighter than sul tasto with the shunt engaged", () => {
      const bright = (out: Float32Array): number => {
        let num = 0, den = 0;
        const a = Math.round(0.8 * FS);
        for (let i = a + 1; i < out.length; i++) {
          const d = out[i] - out[i - 1];
          num += d * d;
          den += out[i] * out[i];
        }
        return num / Math.max(1e-12, den);
      };
      const pont = bright(bowed(0.55, 0.22, 0.7, 0.96));
      const tasto = bright(bowed(0.55, 0.2, 0.32, 0.6));
      expect(pont).toBeGreaterThan(tasto * 1.6);
    });
  });
});
