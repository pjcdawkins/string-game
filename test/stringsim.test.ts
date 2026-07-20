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

  describe("thermal (plastic) friction", () => {
    const base = { f0: 196, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0.35 };

    // A ramped, optionally bitten stroke driven with the app's 30 fps parameter
    // quantisation. `node`/`land` add a stopped note whose finger is still
    // landing (pressure ramps in) — the hardest attack corner. `spec` carries
    // the thermal (and any other) fields; returns the raw string signal.
    const bowStroke = (
      spec: object,
      opts: { speed: number; force: number; pos: number; ramp: number; bite?: number; node?: number; land?: boolean; secs?: number },
    ): Float32Array => {
      const sim = new StringSim(FS);
      sim.setString(spec as Parameters<StringSim["setString"]>[0]);
      sim.bodyMix = 0;
      sim.bowPosition = opts.pos;
      if (opts.node !== undefined) {
        sim.fingerOn = true;
        sim.fingerPosition = opts.node - FINGER_RADIUS;
      }
      sim.bowOn = true;
      const out = new Float32Array(Math.round((opts.secs ?? 1.0) * FS));
      let t = 0;
      const FRAME = 1 / 30;
      let lastFrame = -1;
      for (let i = 0; i + 128 <= out.length; i += 128) {
        t += 128 / FS;
        const frame = Math.floor(t / FRAME);
        if (frame !== lastFrame) {
          lastFrame = frame;
          sim.bowVelocity = opts.speed * Math.min(1, t / opts.ramp);
          sim.bowForce = opts.force * (1 + (opts.bite ?? 0) * Math.exp(-t / 0.25));
          if (opts.node !== undefined) sim.fingerPressure = opts.land ? Math.min(1, t / 0.12) : 1;
        }
        sim.process(out.subarray(i, i + 128));
      }
      return out;
    };

    // fraction of strokes that settle within ~half a semitone of `target`, over
    // several stochastic strokes (the friction has force noise).
    const captureRate = (spec: object, opts: Parameters<typeof bowStroke>[1], target: number, trials: number): number => {
      let ok = 0;
      for (let k = 0; k < trials; k++) {
        const f = estimatePitch(bowStroke(spec, opts), 0.55, 0.95);
        if (f > 0 && Math.abs(1200 * Math.log2(f / target)) < 55) ok++;
      }
      return ok / trials;
    };

    it("thermal = 0 is the classic velocity curve (same as omitting it)", () => {
      // the field defaults to 0; with it explicitly 0 the friction path is
      // byte-for-byte the no-field case (θ ≡ 1, muD untouched). Pin the force
      // noise to a fixed sequence and assert the two strokes are identical.
      const orig = Math.random;
      const seeded = () => {
        let s = 0x51ed2701;
        return () => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s / 0x7fffffff;
        };
      };
      const opts = { speed: 0.3, force: 0.5, pos: 0.85, ramp: 0.12, bite: 0.4 };
      let withZero: Float32Array;
      let omitted: Float32Array;
      try {
        Math.random = seeded();
        withZero = bowStroke({ ...base, thermal: 0 }, opts);
        Math.random = seeded();
        omitted = bowStroke({ ...base }, opts);
      } finally {
        Math.random = orig;
      }
      let maxDiff = 0;
      for (let i = 0; i < withZero.length; i++) maxDiff = Math.max(maxDiff, Math.abs(withZero[i] - omitted[i]));
      expect(maxDiff).toBe(0);
    });

    it("widens the attack wedge monotonically at the hardest low-G corner", () => {
      // A high stop (node 0.7) bowed over the fingerboard on the G is flautando
      // territory: a fast-ramp attack with the finger still landing locks the
      // octave almost every time with the classic curve. Thermal friction pulls
      // capture of the true fundamental up monotonically. (One of the two hard
      // corners the finite-hair note documents; here thermal, not hair, fixes it.)
      const corner = { speed: 0.3, force: 0.5, pos: 0.83, ramp: 0.03, node: 0.7, land: true };
      const target = 196 / (1 - 0.7); // sounding ~653 Hz
      const trials = 40;
      const off = captureRate({ ...base, thermal: 0 }, corner, target, trials);
      const mid = captureRate({ ...base, thermal: 0.2 }, corner, target, trials);
      const on = captureRate({ ...base, thermal: 0.4 }, corner, target, trials);
      expect(off).toBeLessThan(0.3); // classic curve locks the octave
      expect(mid).toBeGreaterThan(off + 0.3); // already climbing at a modest amount
      expect(on).toBeGreaterThan(0.85); // and reliable at the string's tuned value
    }, 60000);

    it("opens a friction–velocity hysteresis loop", () => {
      // With the classic curve the friction is a single-valued function of the
      // sliding velocity, so the (vSlip, friction) trajectory over a Helmholtz
      // cycle retraces itself — negligible enclosed area (only force-noise
      // scatter). Thermal makes the coefficient depend on the lagging contact
      // temperature, so the slip branch traces a genuine loop with area. Drive
      // the sim sample-by-sample and integrate the enclosed area (shoelace).
      const loopArea = (thermal: number): number => {
        const sim = new StringSim(FS);
        sim.setString({ ...base, nonlinearity: 0, thermal });
        sim.bodyMix = 0;
        sim.bowOn = true;
        sim.bowPosition = 0.85;
        sim.bowForce = 0.5;
        const N = Math.round(1.0 * FS);
        const vs: number[] = [];
        const fr: number[] = [];
        let t = 0;
        sim.beginBlock();
        for (let i = 0; i < N; i++) {
          t += 1 / FS;
          sim.bowVelocity = 0.2 * Math.min(1, t / 0.12);
          if (i % 128 === 0) sim.beginBlock();
          sim.tickBridgeRead();
          sim.tickComplete(0);
          if (i > 0.6 * FS && i < 0.6 * FS + 4000) {
            vs.push(sim.bowSlipVel);
            fr.push(sim.bowFriction);
          }
        }
        let area = 0;
        for (let i = 0; i < vs.length; i++) {
          const j = (i + 1) % vs.length;
          area += vs[i] * fr[j] - vs[j] * fr[i];
        }
        return Math.abs(0.5 * area);
      };
      const off = loopArea(0);
      const on = loopArea(0.4);
      expect(on).toBeGreaterThan(off * 4); // the loop genuinely opens
      expect(on).toBeGreaterThan(0.5);
    }, 30000);

    it("sustains Helmholtz at f0 with thermal engaged, without choking or pumping", () => {
      const level = (thermal: number, n = 5): number => {
        let s = 0;
        for (let i = 0; i < n; i++) s += rms(bowStroke({ ...base, thermal }, { speed: 0.3, force: 0.5, pos: 0.85, ramp: 0.12, bite: 0.4, secs: 1.4 }), 0.6, 1.1);
        return s / n;
      };
      const out = bowStroke({ ...base, thermal: 0.4 }, { speed: 0.3, force: 0.5, pos: 0.85, ramp: 0.12, bite: 0.4, secs: 1.4 });
      expectNoNaN(out);
      const f = estimatePitch(out, 0.8, 1.35);
      expect(f).toBeGreaterThan(196 * 0.97);
      expect(f).toBeLessThan(196 * 1.03);
      const on = level(0.4);
      const off = level(0);
      expect(on).toBeGreaterThan(off * 0.6);
      expect(on).toBeLessThan(off * 1.6);
    }, 30000);

    it("leaves the stick-dominated extremes intact (slow bow, over-pressure, sul pont)", () => {
      const th = 0.4;
      const slow = bowStroke({ ...base, thermal: th }, { speed: 0.06, force: 0.4, pos: 0.85, ramp: 0.12, secs: 1.4 });
      expectNoNaN(slow);
      expect(rms(slow, 0.8, 1.3)).toBeGreaterThan(0.02); // a slow bow still speaks

      const heavy = bowStroke({ ...base, thermal: th }, { speed: 0.3, force: 1.4, pos: 0.85, ramp: 0.12 });
      expectNoNaN(heavy);
      expect(rms(heavy, 0.6, 0.95)).toBeGreaterThan(0.05); // over-pressure still crunches

      const bright = (out: Float32Array): number => {
        let num = 0, den = 0;
        const a = Math.round(0.6 * FS);
        for (let i = a + 1; i < out.length; i++) {
          const d = out[i] - out[i - 1];
          num += d * d;
          den += out[i] * out[i];
        }
        return num / Math.max(1e-12, den);
      };
      const pont = bright(bowStroke({ ...base, thermal: th }, { speed: 0.22, force: 0.7, pos: 0.96, ramp: 0.12 }));
      const tasto = bright(bowStroke({ ...base, thermal: th }, { speed: 0.2, force: 0.32, pos: 0.6, ramp: 0.12 }));
      expect(pont).toBeGreaterThan(tasto * 1.6); // ponticello still ≫ tasto
    }, 30000);

    it("tames the flat-hair pressure whistle on the low G (composes with the Hair control)", () => {
      // #54's finite-hair note: at its useful strength the flat hair, leaned on
      // hard near the bridge, tips the low open G into a surface whistle (a high
      // mode locks and the fundamental is lost). Thermal friction resists that
      // spurious high-mode lock, so with it engaged the fundamental holds — the
      // two stabilisers compose. Fraction of heavy near-bridge strokes that keep
      // the ~196 Hz fundamental, hair flat (w = 0.06), off vs on.
      const fundamentalRate = (thermal: number, trials: number): number => {
        let ok = 0;
        for (let k = 0; k < trials; k++) {
          const sim = new StringSim(FS);
          sim.setString({ ...base, thermal });
          sim.bodyMix = 0;
          sim.bowHairWidth = 0.06; // hair laid flat (the "Hair" slider well up)
          sim.bowOn = true;
          sim.bowPosition = 0.9; // heavy and near the bridge
          sim.bowForce = 1.3;
          const out = new Float32Array(Math.round(1.0 * FS));
          let t = 0;
          for (let i = 0; i + 128 <= out.length; i += 128) {
            t += 128 / FS;
            sim.bowVelocity = 0.18 * Math.min(1, t / 0.1);
            sim.process(out.subarray(i, i + 128));
          }
          const f = estimatePitch(out, 0.55, 0.95);
          if (f > 0 && Math.abs(1200 * Math.log2(f / 196)) < 90) ok++;
        }
        return ok / trials;
      };
      const off = fundamentalRate(0, 28);
      const on = fundamentalRate(0.4, 28);
      expect(off).toBeLessThan(0.35); // flat hair alone whistles under heavy pressure
      expect(on).toBeGreaterThan(0.85); // thermal holds the fundamental
    }, 60000);
  });

  describe("bow-speed gate on the attack wedge", () => {
    // The torsional slip-loss and thermal softening widen the Helmholtz capture
    // region — wanted for a bow drawn ACROSS the string, but not for one dragged
    // ALONG it (a vertical drag), where the only transverse velocity is pointer
    // jitter. There a widened wedge let that jitter lock the string into a
    // spurious, over-loud sustained tone. The bow-speed gate fades both effects
    // out below WEDGE_V1, so at jitter-level speeds the string reverts to the
    // plain friction curve and no longer "activates".
    const base = { f0: 196, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0.35 };

    const settledLevel = (spec: object, bowVel: number, pos: number): number => {
      const sim = new StringSim(FS);
      sim.setString(spec as Parameters<StringSim["setString"]>[0]);
      sim.bodyMix = 0;
      sim.bowOn = true;
      sim.bowForce = 0.5;
      sim.bowPosition = pos;
      sim.bowVelocity = bowVel;
      const out = new Float32Array(Math.round(2.5 * FS));
      for (let i = 0; i + 128 <= out.length; i += 128) sim.process(out.subarray(i, i + 128));
      return rms(out, 1.6, 2.4);
    };

    it("at jitter-level bow speed the wedge is off (tors+therm ≈ plain curve)", () => {
      const on = { ...base, torsional: 0.55, thermal: 0.4 };
      const off = { ...base, torsional: 0, thermal: 0 };
      // below WEDGE_V0 (0.005) the wedge is fully closed: the two effects add
      // essentially nothing over the plain curve, so a vertical-drag jitter no
      // longer speaks louder than it did before torsion/thermal existed.
      for (const bv of [0.002, 0.004]) {
        const lvlOn = settledLevel(on, bv, 0.7);
        const lvlOff = settledLevel(off, bv, 0.7);
        expect(lvlOn).toBeLessThan(lvlOff * 1.15);
      }
    });

    it("a genuine stroke still gets the full wedge (unchanged at playing speed)", () => {
      // Well above WEDGE_V1 the gate is wide open, so a real détaché is driven
      // by the full torsional + thermal wedge exactly as before the gate.
      const on = { ...base, torsional: 0.55, thermal: 0.4 };
      const fast = settledLevel(on, 0.2, 0.85);
      expect(fast).toBeGreaterThan(0.06); // the string speaks strongly when actually bowed
      // and the wedge is meaningfully engaged relative to the closed-gate case
      const off = { ...base, torsional: 0, thermal: 0 };
      const slowOn = settledLevel(on, 0.003, 0.85);
      const slowOff = settledLevel(off, 0.003, 0.85);
      expect(slowOn).toBeLessThan(slowOff * 1.15); // gate closed at jitter speed
    });
  });
});
