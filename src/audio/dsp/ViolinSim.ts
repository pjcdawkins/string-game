/**
 * The whole instrument: four StringSim waveguides terminated on ONE bridge.
 *
 * On a real violin the strings are not independent — they all bear on the
 * same bridge, and the bridge is where sympathetic resonance lives: the
 * played string shakes the bridge, the bridge shakes the other strings, and
 * only partials that coincide with a sibling string's own modes accumulate
 * (everything else cancels within a round trip). This class models that
 * junction physically rather than faking it with resonators:
 *
 * With velocity waves and per-string impedance Z = 1, a bridge of admittance
 * Y_B(z) common to all N strings gives a bridge velocity
 *
 *   v_B = Γ(z) · Σ_k v_k⁺,   Γ = 2·Y_B / (1 + N·Y_B),
 *
 * and each string's reflection v_k⁻ = v_B − v_k⁺. The uncoupled model's
 * reflection is −H_k(v_k⁺), i.e. the (1 − H_k) shortfall per bounce is
 * exactly what the bridge takes out of string k — partly dissipated, partly
 * radiated through the body (the output tap), partly handed to the other
 * strings. So each string keeps its own termination filter (loss +
 * dispersion, unchanged), and the junction adds the cross-transmission term:
 * string k receives γ · Σ_{j≠k} H_j(v_j⁺), the loss-filtered waves its
 * siblings delivered to the bridge this very sample. Using the H_j-filtered
 * wave as the transmitted signal is the physical choice — it is the part of
 * the wave the bridge actually receives — and the shared filtering means the
 * coupling, like a real bridge, passes mid/high frequencies more readily.
 *
 * The coupling is two-way: the played string also loses energy into (and is
 * minutely pulled by) its sympathizers, as on the instrument. γ is small, so
 * the worst-case coupled loop gain stays comfortably below the strings' own
 * round-trip losses — see the stability test in test/violinsim.test.ts.
 *
 * The body is likewise shared: one modal filter bank driven by the SUM of
 * the bridge forces, because the top plate feels one bridge, not four.
 * Consequences that fall out for free, all real: switching strings leaves
 * the old string ringing until it decays; a lifted finger leaves the open
 * string sounding quietly; sympathetic ring-on is audible after the played
 * note stops; slightly detuned near-coincidences beat instead of blooming.
 */

import { BodyOutput, StringSim } from "./StringSim";
import type { SimState, StringSpec } from "./StringSim";

/**
 * Bridge cross-transmission γ: the fraction of each string's loss-filtered
 * incoming bridge wave handed to EACH other string per reflection. Physically
 * this is a small share of the termination's (1 − H) energy shortfall. The
 * audible sympathetic level is γ amplified by the receiving string's Q — a
 * receiving round-trip gain of ~0.994 builds an on-coincidence resonance up
 * by ~×160 — so γ ≈ 1e-3 lands the open-string ring around 15–20 dB below
 * the played note at a perfect unison: clearly there, gently, as on the
 * instrument. It also keeps the coupled system safely passive: the worst
 * fully-coincident loop eigenvalue grows by only (N−1)·γ ≈ 0.003.
 */
const BRIDGE_COUPLING = 0.0015;

export class ViolinSim {
  readonly strings: StringSim[];

  // --- control inputs, mirroring StringSim's; they act on the played string
  bowOn = false;
  bowVelocity = 0;
  bowForce = 0.3;
  bowPosition = 0.88;
  bowHairWidth = 0; // bow-hair ribbon width; 0 = point contact (see StringSim.bowHairWidth)
  fingerOn = false;
  fingerPosition = 0.3;
  fingerPressure = 0;
  bodyMix = 0.75;
  masterGain = 0.9;

  private played: number;

  // shared body: one bridge drives one top plate (the same output chain the
  // solo StringSim path uses — see BodyOutput)
  private output: BodyOutput;

  // per-sample scratch for the junction (no allocation in process())
  private rWave: Float64Array;

  constructor(sampleRate: number, specs: StringSpec[], playedIdx = 0) {
    this.strings = specs.map((spec) => {
      const sim = new StringSim(sampleRate);
      sim.setString(spec);
      return sim;
    });
    this.played = Math.min(this.strings.length - 1, Math.max(0, playedIdx));
    this.rWave = new Float64Array(this.strings.length);
    this.output = new BodyOutput(sampleRate);
  }

  /** Move the bow/finger to another string. Nothing is reset: the string
   * just left keeps ringing and decays on its own, as on the instrument. */
  selectString(idx: number): void {
    if (idx >= 0 && idx < this.strings.length) this.played = idx;
  }

  get playedIndex(): number {
    return this.played;
  }

  /** Pluck the played string (at its current bow position). */
  pluck(force: number, widthMs: number, periodFrac = 0): void {
    this.strings[this.played].pluck(force, widthMs, periodFrac);
  }

  /** Instantly silence the whole instrument. */
  reset(): void {
    for (const s of this.strings) s.reset();
    this.output.clear();
  }

  getState(): SimState {
    // pitch/slip/bowing describe the played string; level describes the mix
    const st = this.strings[this.played].getState();
    st.rms = this.output.rms;
    return st;
  }

  /** Per-string vibration amplitudes (each StringSim's slow bridge-wave
   * envelope), indexed like `strings`. Feeds the visualisation: an unplayed
   * string ringing — sympathetically, or decaying after the bow left it —
   * brightens in proportion. */
  stringAmplitudes(): number[] {
    return this.strings.map((s) => s.amplitude());
  }

  /** Render `out.length` mono samples of the whole instrument. */
  process(out: Float32Array): void {
    const sims = this.strings;
    const n = sims.length;
    for (let k = 0; k < n; k++) {
      const s = sims[k];
      if (k === this.played) {
        s.contact = true;
        s.bowOn = this.bowOn;
        s.bowVelocity = this.bowVelocity;
        s.bowForce = this.bowForce;
        s.bowPosition = this.bowPosition;
        s.bowHairWidth = this.bowHairWidth;
        s.fingerOn = this.fingerOn;
        s.fingerPosition = this.fingerPosition;
        s.fingerPressure = this.fingerPressure;
      } else {
        // nothing touches an unplayed string: no bow, no finger — and no
        // inherited geometry either. Positions keep their last values (the
        // transparent finger junction makes them acoustically moot), and
        // contact=false pins the bridge filter to the string's neutral
        // darkness so the played string's bow can't colour or retune a
        // string that is merely ringing.
        s.contact = false;
        s.bowOn = false;
        s.fingerOn = false;
      }
      s.beginBlock();
    }

    this.output.bodyMix = this.bodyMix;
    this.output.masterGain = this.masterGain;

    const r = this.rWave;
    for (let i = 0; i < out.length; i++) {
      // gather every string's loss-filtered incoming bridge wave first…
      let sum = 0;
      for (let k = 0; k < n; k++) {
        r[k] = sims[k].tickBridgeRead();
        sum += r[k];
      }
      // …then reflect, each string receiving its siblings' transmission,
      // and sum the raw bridge forces into the one top plate
      let force = 0;
      for (let k = 0; k < n; k++) {
        sims[k].tickComplete(BRIDGE_COUPLING * (sum - r[k]));
        force += sims[k].bridgeForce;
      }

      // --- output: total bridge force -> the shared body/output chain
      out[i] = this.output.process(force);
    }
  }
}
