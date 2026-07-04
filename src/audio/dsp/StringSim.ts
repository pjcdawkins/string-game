/**
 * Physical model of a single bowed/plucked string.
 *
 * Topology: a digital waveguide split into three segments by two scattering
 * junctions, using velocity waves (string wave impedance normalised to Z = 1):
 *
 *   nut |--- segment A ---| finger |--- segment B ---| bow |--- segment C ---| bridge
 *
 * - The NUT reflects with a near-unity inverting coefficient.
 * - The FINGER junction is a variable damper of resistance Rf pressed against
 *   the string. Rf = 0 is a transparent (open string) junction; small Rf is a
 *   light harmonic touch (it absorbs every mode that does not have a node at
 *   the touch point, leaving the natural harmonic); large Rf approaches a
 *   rigid stop, which shortens the speaking length to finger->bridge.
 * - The BOW junction applies the classic stick-slip friction model
 *   (McIntyre/Schumacher/Woodhouse): a hyperbolic kinetic friction curve,
 *   solved in closed form (quadratic) each sample. Plucks (plectrum/finger
 *   pizz) are injected at the same point as a raised-cosine force pulse whose
 *   duration encodes the hardness/width of the plucking implement.
 * - The BRIDGE reflects through a one-pole loss/brightness filter and a pair
 *   of allpasses that model string stiffness (dispersion / inharmonicity).
 *   The transmitted bridge force drives a small modal body filter.
 *
 * Everything is pure TypeScript with no Web Audio dependency, so the model is
 * unit-testable in Node and runs comfortably in real time inside an
 * AudioWorklet (single string, ~10 arithmetic-light ops per sample — no WASM
 * required).
 */

import {
  AllpassDispersion,
  BiquadBP,
  DCBlocker,
  DelayLine,
  OnePoleLP,
  Smoother,
} from "./filters";
import { FINGER_RADIUS, MAX_STOP_NODE } from "../../state";

export interface StringSpec {
  /** Open-string fundamental in Hz. */
  f0: number;
  /** Bridge reflection brightness: 0 = bright, 1 = dark. */
  darkness: number;
  /** Round-trip loss, 0..1 (0.999 rings long). */
  loss: number;
  /** Stiffness/dispersion amount 0..1. */
  stiffness: number;
  /**
   * Tension-modulation coefficient (geometric nonlinearity): large-amplitude
   * vibration stretches the string and raises its pitch, most audibly on the
   * low, floppy strings when driven hard sul tasto. 0 disables the effect.
   */
  nonlinearity: number;
}

export interface SimState {
  rms: number;
  slipRatio: number; // fraction of recent samples in slip phase (bowing texture)
  freq: number; // current fundamental implied by delay lengths
  bowing: boolean;
}

const MU_S = 0.8; // static friction coefficient
const MU_D = 0.3; // dynamic friction coefficient

// Terminating-node positions (fraction of the string from the nut) over which
// a stopped finger releases into the open string as it nears the nut. With the
// node at or below NUT_OPEN the string is fully open; the damping ramps back to
// a firm stop over the next NUT_FADE. Kept well clear of the first real stopped
// note (node ~0.056, a semitone above the open string).
const NUT_OPEN = 0.015;
const NUT_FADE = 0.03;

export class StringSim {
  readonly fs: number;

  // --- public control inputs (set freely from outside; smoothed internally)
  bowOn = false;
  bowVelocity = 0; // signed, ~[-0.6, 0.6]
  bowForce = 0.3; // >= 0, useful range ~[0.02, 1.5]
  bowPosition = 0.88; // 0 = nut, 1 = bridge (clamped to playable range)
  fingerOn = false;
  fingerPosition = 0.3; // fingertip CENTRE; 0 = nut, 1 = bridge (may go slightly
  // negative when the finger slides up onto the nut). The terminating node sits
  // one FINGER_RADIUS toward the bridge — see clampedPositions().
  fingerPressure = 0; // 0 = off, ~0.1 = harmonic touch, 1 = firm stop
  bodyMix = 0.75; // 0 = raw string, 1 = full body filter
  masterGain = 0.9;

  private spec: StringSpec = {
    f0: 220,
    darkness: 0.3,
    loss: 0.4,
    stiffness: 0.2,
    nonlinearity: 0.15,
  };

  // delay lines: right-going (toward bridge) and left-going (toward nut)
  private aR: DelayLine;
  private aL: DelayLine;
  private bR: DelayLine;
  private bL: DelayLine;
  private cR: DelayLine;
  private cL: DelayLine;

  private dA: Smoother;
  private dB: Smoother;
  private dC: Smoother;
  private rfSm: Smoother;
  private bowVelSm: Smoother;
  private bowForceSm: Smoother;

  private bridgeLP = new OnePoleLP();
  private disp1 = new AllpassDispersion();
  private disp2 = new AllpassDispersion();
  private dc = new DCBlocker();
  private nutCoeff = 0.997;

  // body filter: a handful of violin-ish modal resonances
  private body: BiquadBP[] = [];

  // pluck pulse state
  private pluckSamplesLeft = 0;
  private pluckLen = 0;
  private pluckAmp = 0;
  private pluckPhase = 0;

  // metering
  private rmsAcc = 0;
  private rmsVal = 0;
  private rmsCount = 0;
  private slipAcc = 0;
  private slipVal = 0;

  // slow EMA of squared string amplitude, drives tension-modulation detune
  private amp2 = 0;
  private amp2Coeff = 0;

  constructor(sampleRate: number, minF0 = 60) {
    this.fs = sampleRate;
    const maxDelay = Math.ceil(sampleRate / (2 * minF0)) + 8;
    this.aR = new DelayLine(maxDelay);
    this.aL = new DelayLine(maxDelay);
    this.bR = new DelayLine(maxDelay);
    this.bL = new DelayLine(maxDelay);
    this.cR = new DelayLine(maxDelay);
    this.cL = new DelayLine(maxDelay);

    const slew = sampleRate * 0.004; // ~4 ms position/parameter glide
    this.dA = new Smoother(10, slew);
    this.dB = new Smoother(10, slew);
    this.dC = new Smoother(10, slew);
    this.rfSm = new Smoother(0, sampleRate * 0.003);
    this.bowVelSm = new Smoother(0, sampleRate * 0.006);
    this.bowForceSm = new Smoother(0, sampleRate * 0.004);
    this.amp2Coeff = 1 - Math.exp(-1 / (0.03 * sampleRate)); // ~30 ms tracker

    const modes: Array<[number, number, number]> = [
      [275, 9, 1.5], // "breathing" A0 mode
      [460, 8, 1.2],
      [550, 11, 1.0],
      [700, 7, 0.9],
      [1000, 7, 0.8],
      [1400, 8, 0.7],
      [2600, 6, 0.85],
      [3400, 7, 0.5],
    ];
    for (const [f, q, g] of modes) {
      const bq = new BiquadBP();
      bq.set(f, q, g, sampleRate);
      this.body.push(bq);
    }

    this.setString(this.spec);
    // start delays at their targets to avoid an initial glide
    const t = this.delayTargets();
    this.dA.jump(t[0]);
    this.dB.jump(t[1]);
    this.dC.jump(t[2]);
  }

  setString(spec: StringSpec): void {
    this.spec = { ...spec };
    this.bridgeLP.a = 0.12 + 0.5 * spec.darkness;
    this.bridgeLP.gain = 1 - 0.0015 - 0.006 * spec.loss;
    const c = -0.12 * spec.stiffness;
    this.disp1.c = c;
    this.disp2.c = c;
  }

  getSpec(): StringSpec {
    return { ...this.spec };
  }

  /**
   * Trigger a pluck at the current bowPosition. The pulse width sets the
   * implement's hardness: a sharp plectrum is a fixed absolute `widthMs`, while
   * a soft fingertip is better expressed as a fraction of the current period
   * (`periodFrac` > 0 overrides `widthMs`). A soft pulse is spread over a large
   * fraction of the period, so its raised-cosine force partly cancels itself
   * against the string's own motion during injection and the note comes out
   * quieter. Keying the finger's width to the period keeps that self-cancellation
   * — hence the loudness and the mellow tone — consistent across the range,
   * instead of a fixed-ms pulse that is ~1 period on the low strings but several
   * periods (and near-silent) on the high ones.
   */
  pluck(force: number, widthMs: number, periodFrac = 0): void {
    let len = Math.round((widthMs / 1000) * this.fs);
    if (periodFrac > 0) {
      const total = this.dA.value + this.dB.value + this.dC.value;
      const comp = this.bridgeLP.phaseDelay() + this.disp1.delayAtDC() + this.disp2.delayAtDC();
      const vibLen = this.effectiveRf() > 4 ? this.dB.value + this.dC.value : total;
      const period = 2 * vibLen + comp;
      len = Math.round(periodFrac * period);
    }
    this.pluckLen = Math.max(8, len);
    this.pluckSamplesLeft = this.pluckLen;
    // a gentle width compensation keeps a mellow (wider) pizz from dropping too
    // far below a sharp plectrum stroke of the same force
    const widthMsActual = (this.pluckLen / this.fs) * 1000;
    const widthComp = 1 + 0.06 * Math.max(0, widthMsActual - 0.8);
    this.pluckAmp = 0.55 * Math.min(1.5, Math.max(0, force)) * widthComp;
    this.pluckPhase = 0;
  }

  /** Instantly silence the string. */
  reset(): void {
    for (const d of [this.aR, this.aL, this.bR, this.bL, this.cR, this.cL]) d.clear();
    this.bridgeLP.clear();
    this.disp1.clear();
    this.disp2.clear();
    this.dc.clear();
    for (const b of this.body) b.clear();
    this.pluckSamplesLeft = 0;
    this.amp2 = 0;
  }

  getState(): SimState {
    const total = this.dA.value + this.dB.value + this.dC.value;
    const comp = this.bridgeLP.phaseDelay() + this.disp1.delayAtDC() + this.disp2.delayAtDC();
    const vibLen = this.effectiveRf() > 4 ? this.dB.value + this.dC.value : total;
    const roundTrip = 2 * vibLen + comp;
    return {
      rms: this.rmsVal,
      slipRatio: this.slipVal,
      freq: this.fs / Math.max(4, roundTrip),
      bowing: this.bowOn,
    };
  }

  private effectiveRf(): number {
    if (!this.fingerOn || this.fingerPressure <= 0) return 0;
    // light touch ~ a few units (harmonic-selecting damper); firm press is a
    // near-rigid termination (kept finite so a trace of nut-side coupling
    // and finger damping remains, as on a real fingerboard)
    const q = Math.min(1, this.fingerPressure);
    const rf = 200 * q * q * q + 8 * q;
    // As the terminating node (the finger's bridge-side edge) reaches the nut,
    // fade the damping out so the full string length speaks (the true open
    // pitch) instead of terminating a hair short and sounding slightly sharp —
    // the min-segment clamp in delayTargets() would otherwise hold the junction
    // ~2 samples off the nut. This also releases the stop smoothly into the
    // open string as the finger slides up, like a glissando from the open note.
    const node = this.fingerPosition + FINGER_RADIUS;
    const nutFade = Math.min(1, Math.max(0, (node - NUT_OPEN) / NUT_FADE));
    return rf * nutFade;
  }

  private clampedPositions(): [number, number] {
    // the fleshy fingertip terminates the string at the bridge-side edge of its
    // contact, a radius past the finger centre; slid up onto the nut (centre
    // <= -FINGER_RADIUS) the node reaches 0 and the string speaks open. The node
    // may run well past the fingerboard's end toward the bridge — the pitch (and,
    // for a light touch, the selected flageolet) keeps rising into the very high
    // register up to MAX_STOP_NODE, where the bow can only just still fit.
    const pf = Math.min(MAX_STOP_NODE, Math.max(0, this.fingerPosition + FINGER_RADIUS));
    const pb = Math.min(0.99, Math.max(pf + 0.05, this.bowPosition));
    return [pf, pb];
  }

  private delayTargets(): [number, number, number] {
    const comp = this.bridgeLP.phaseDelay() + this.disp1.delayAtDC() + this.disp2.delayAtDC();
    // tension modulation: vibration amplitude stretches the string slightly,
    // raising the pitch — shorten all segments by the same factor
    // only amplitudes beyond ordinary playing stretch the string audibly
    const excess = Math.max(0, Math.min(0.045, this.amp2) - 0.012);
    const detune = 1 + this.spec.nonlinearity * excess;
    const oneWay = this.fs / (2 * this.spec.f0 * detune);
    const [pf, pb] = this.clampedPositions();
    // the reflection filters live at the bridge, so their delay is taken
    // entirely out of segment C — tuning then stays exact for stopped notes
    let dA = pf * oneWay;
    let dB = (pb - pf) * oneWay;
    let dC = (1 - pb) * oneWay - comp / 2;
    // enforce minimum segment lengths without changing the total: clamp every
    // short segment up, then recover the added delay from segments that still
    // have slack — otherwise bowing near the bridge (tiny C) or a finger near
    // the nut (tiny A) would lengthen the loop and play flat
    const MIN = 2;
    let deficit = 0;
    if (dA < MIN) {
      deficit += MIN - dA;
      dA = MIN;
    }
    if (dB < MIN) {
      deficit += MIN - dB;
      dB = MIN;
    }
    if (dC < MIN) {
      deficit += MIN - dC;
      dC = MIN;
    }
    if (deficit > 0) {
      const take = (d: number): number => {
        const t = Math.min(deficit, d - MIN);
        deficit -= t;
        return d - t;
      };
      dB = take(dB);
      dC = take(dC);
      dA = take(dA);
    }
    return [dA, dB, dC];
  }

  /** Render `out.length` mono samples. */
  process(out: Float32Array): void {
    const beta = 1 - this.clampedPositions()[1]; // bow-bridge distance fraction

    // contact-point colour: near the bridge the Helmholtz corner stays sharp
    // (less Cremer rounding) and the bridge passes more upper partials; over
    // the fingerboard the tone rounds off and darkens
    const vc = 0.015 + 0.19 * beta; // friction-curve knee
    this.bridgeLP.a = Math.min(0.6, (0.12 + 0.5 * this.spec.darkness) * (0.45 + 2.1 * beta));

    const [tA, tB, tC] = this.delayTargets();
    const rfTarget = this.effectiveRf();
    const bowVelTarget = this.bowOn ? this.bowVelocity : 0;
    const bowForceTarget = this.bowOn ? this.bowForce : 0;

    for (let n = 0; n < out.length; n++) {
      const dA = this.dA.tick(tA);
      const dB = this.dB.tick(tB);
      const dC = this.dC.tick(tC);
      const rf = this.rfSm.tick(rfTarget);
      const vBow = this.bowVelSm.tick(bowVelTarget);
      // small force noise gives the bow its breathy texture
      const fb = this.bowForceSm.tick(bowForceTarget) * (1 + 0.08 * (Math.random() - 0.5));

      // --- waves arriving at each end/junction
      const atNut = this.aL.read(dA);
      const aFng = this.aR.read(dA);
      const bFng = this.bL.read(dB);
      const bBow = this.bR.read(dB);
      const cBow = this.cL.read(dC);
      const atBridge = this.cR.read(dC);

      // amplitude tracker for the tension-modulation detune
      this.amp2 += this.amp2Coeff * (atBridge * atBridge - this.amp2);

      // --- nut reflection
      const nutOut = -this.nutCoeff * atNut;

      // --- bridge reflection (loss + stiffness), output tap
      const bridgeOut = -this.disp2.process(this.disp1.process(this.bridgeLP.process(atBridge)));

      // --- finger junction (damper of resistance rf, Z = 1 both sides)
      const tCoef = 2 / (2 + rf);
      const vF = tCoef * (aFng + bFng);
      const fngToB = vF - bFng;
      const fngToA = vF - aFng;

      // --- bow junction: stick-slip friction
      const vh = bBow + cBow; // free string velocity at the bow point
      let vJ = vh;
      let slipping = 0;
      if (fb > 1e-4) {
        const k = 0.5 * fb; // F/(2Z)
        const d = vBow - vh;
        const ad = Math.abs(d);
        if (ad <= k * MU_S) {
          vJ = vBow; // stick: string moves with the bow
        } else {
          // slip: solve s^2 + B s + C = 0 for slip speed s = |vBow - vJ|
          const B = vc - ad + k * MU_D;
          const C = vc * (k * MU_S - ad); // < 0 here => one positive root
          const s = 0.5 * (-B + Math.sqrt(B * B - 4 * C));
          vJ = vBow - Math.sign(d) * s;
          slipping = 1;
        }
      }
      let bowToC = vJ - cBow;
      let bowToB = vJ - bBow;

      // --- pluck force injection (raised cosine pulse)
      if (this.pluckSamplesLeft > 0) {
        const ph = this.pluckPhase / this.pluckLen;
        const p = this.pluckAmp * 0.5 * (1 - Math.cos(2 * Math.PI * ph));
        bowToC += p;
        bowToB += p;
        this.pluckPhase++;
        this.pluckSamplesLeft--;
      }

      // --- advance delay lines
      this.aR.write(nutOut);
      this.aL.write(fngToA);
      this.bR.write(fngToB);
      this.bL.write(bowToB);
      this.cR.write(bowToC);
      this.cL.write(bridgeOut);

      // --- output: bridge force -> body filter
      const dry = this.dc.process(atBridge);
      let wet = 0;
      for (let i = 0; i < this.body.length; i++) wet += this.body[i].process(dry);
      let y = this.masterGain * ((1 - this.bodyMix) * dry + this.bodyMix * (0.32 * dry + wet));
      // gentle safety saturation
      y = Math.tanh(1.4 * y) * 0.72;
      out[n] = y;

      this.rmsAcc += y * y;
      this.slipAcc += slipping;
      this.rmsCount++;
      if (this.rmsCount >= 512) {
        this.rmsVal = Math.sqrt(this.rmsAcc / this.rmsCount);
        this.slipVal = this.slipAcc / this.rmsCount;
        this.rmsAcc = 0;
        this.slipAcc = 0;
        this.rmsCount = 0;
      }
    }
  }
}
