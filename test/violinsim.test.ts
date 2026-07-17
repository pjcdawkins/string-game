import { describe, expect, it } from "vitest";
import { ViolinSim } from "../src/audio/dsp/ViolinSim";
import { FINGER_RADIUS, STRINGS } from "../src/state";

const FS = 48000;

const SPECS = STRINGS.map((s) => s.spec);
const G = 0;
const D = 1;
const A = 2;
const E = 3;

function makeViolin(played: number): ViolinSim {
  return new ViolinSim(FS, SPECS, played);
}

function render(sim: ViolinSim, seconds: number): Float32Array {
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

function expectNoNaN(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) throw new Error(`non-finite sample at ${i}: ${buf[i]}`);
  }
}

/** Bow the played string with a ramped attack (as the app's stroke envelopes
 * do — a cold instant onset lands outside the Guettler wedge and captures a
 * wrong regime, see MODEL_NOTES.md), then lift the bow. */
function bowRamped(v: ViolinSim, vel: number, force: number, seconds: number): Float32Array {
  v.bowOn = true;
  v.bowForce = force;
  v.bowPosition = 0.88;
  const out = new Float32Array(Math.round(seconds * FS));
  let t = 0;
  for (let i = 0; i + 128 <= out.length; i += 128) {
    t += 128 / FS;
    v.bowVelocity = vel * Math.min(1, t / 0.15);
    v.process(out.subarray(i, i + 128));
  }
  v.bowOn = false;
  return out;
}

/** Stop the played string so its fundamental lands on `freq`. */
function stopAt(v: ViolinSim, playedF0: number, freq: number): void {
  v.fingerOn = true;
  v.fingerPosition = 1 - playedF0 / freq - FINGER_RADIUS;
  v.fingerPressure = 1;
}

describe("ViolinSim (four strings coupled at the bridge)", () => {
  it("a stopped unison makes the matching open string ring sympathetically", () => {
    // stop E5 on the A string: exact unison with the open E (pure-fifth tuning)
    const unison = makeViolin(A);
    render(unison, 0.1); // settle from silence
    stopAt(unison, SPECS[A].f0, SPECS[E].f0);
    expectNoNaN(bowRamped(unison, 0.15, 0.4, 1.4));
    const eDuring = unison.strings[E].amplitude();
    const playedAmp = unison.strings[A].amplitude();

    // control: stop a semitone lower (D#5) — no coincidence with open E
    const control = makeViolin(A);
    render(control, 0.1);
    stopAt(control, SPECS[A].f0, SPECS[E].f0 / Math.pow(2, 1 / 12));
    expectNoNaN(bowRamped(control, 0.15, 0.4, 1.4));
    const eCtrlDuring = control.strings[E].amplitude();

    // the coincident open string blooms well above the broadband bow-noise
    // floor (which is all the detuned control's E collects)…
    expect(eDuring).toBeGreaterThan(3 * eCtrlDuring);
    // …and stays a gentle halo well below the played note, not a duet
    expect(eDuring).toBeGreaterThan(0.04 * playedAmp);
    expect(eDuring).toBeLessThan(0.4 * playedAmp);

    // after the bow lifts the forced noise dies within a few round trips but
    // the resonantly accumulated energy keeps ringing — the audible halo
    expectNoNaN(render(unison, 0.3));
    expectNoNaN(render(control, 0.3));
    expect(unison.strings[E].amplitude()).toBeGreaterThan(3 * control.strings[E].amplitude());
  });

  it("a plucked open A wakes the D string through their shared 880 Hz partial", () => {
    // open A 440: D's 3rd partial = A's 2nd (880), E's 2nd = A's 3rd (1320) —
    // both exact in pure fifths. G shares nothing below its 9th partial.
    const v = makeViolin(A);
    v.bowPosition = 0.85;
    v.pluck(0.8, 1.2);
    expectNoNaN(render(v, 0.5));
    const g = v.strings[G].amplitude();
    const d = v.strings[D].amplitude();
    const e = v.strings[E].amplitude();
    expect(d).toBeGreaterThan(6 * g);
    expect(e).toBeGreaterThan(2 * g);
  });

  it("sympathetic ring persists after the played string is damped", () => {
    const v = makeViolin(A);
    render(v, 0.1);
    stopAt(v, SPECS[A].f0, SPECS[E].f0);
    bowRamped(v, 0.2, 0.5, 1.2);
    // lift the finger and damp the played string by hand (as a player would)
    v.fingerOn = false;
    render(v, 0.05);
    v.strings[A].reset();
    const after = render(v, 0.6);
    expectNoNaN(after);
    // the open E keeps sounding on its own
    expect(rms(after, 0.1, 0.5)).toBeGreaterThan(1e-4);
    expect(v.strings[E].amplitude()).toBeGreaterThan(1e-4);
  });

  it("switching strings leaves the old string ringing (no reset)", () => {
    const v = makeViolin(A);
    v.bowPosition = 0.85;
    v.pluck(0.8, 1.2);
    const before = render(v, 0.3);
    expectNoNaN(before);
    const ringing = v.strings[A].amplitude();
    expect(ringing).toBeGreaterThan(1e-3);

    v.selectString(E);
    const after = render(v, 0.3);
    expectNoNaN(after);
    // the A string is still sounding, merely decaying
    expect(v.strings[A].amplitude()).toBeGreaterThan(0.1 * ringing);
    expect(rms(after, 0.05, 0.3)).toBeGreaterThan(1e-4);
  });

  it("stays finite and bounded under hard playing (coupling is passive)", () => {
    const v = makeViolin(G);
    v.bowOn = true;
    v.bowVelocity = 0.5;
    v.bowForce = 1.4;
    v.bowPosition = 0.7; // sul tasto, hard: the nastiest regime
    const out = render(v, 3.0);
    expectNoNaN(out);
    for (const s of v.strings) {
      expect(Number.isFinite(s.amplitude())).toBe(true);
      expect(s.amplitude()).toBeLessThan(5);
    }
  });

  it("stays silent and finite with no excitation", () => {
    const v = makeViolin(A);
    const out = render(v, 0.3);
    expectNoNaN(out);
    expect(rms(out, 0.1, 0.3)).toBeLessThan(1e-6);
  });
});
