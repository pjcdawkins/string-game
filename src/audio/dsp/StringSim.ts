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
 *   solved in closed form (quadratic) each sample, optionally with the friction
 *   coefficients thermally modulated (temperature-dependent rosin, a hysteresis
 *   that widens the Helmholtz regime — see THERMAL_* and StringSpec.thermal).
 *   Plucks (plectrum/finger
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
  RibbonAverager,
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
  /**
   * Lossy torsional impedance at the bow point, ~0..1 (0, or omitted,
   * disables it). The bow drives the string *surface*, which twists as well
   * as translates; on a real string the torsional mode is heavily damped, so
   * it acts as a resistive loss channel right at the bow that soaks up the
   * aperiodic transient energy of an attack and widens the Guettler attack
   * wedge. The value is the torsional admittance as a fraction of the
   * transverse admittance (1 => equal). See StringSim.tickComplete.
   */
  torsional?: number;
  /**
   * Thermal (plastic) friction amount, ~0..1 (0, or omitted, disables it).
   * Real rosin friction is temperature-dependent, not velocity-dependent
   * (Smith & Woodhouse 2000): the contact flash-heats as it slips, the rosin
   * softens, and the friction coefficients drop — but the heat (and so the
   * softening) LAGS the sliding by the flash-contact time constant, which turns
   * the friction curve into a hysteresis loop that stabilises attacks and
   * widens the Helmholtz regime. This amount scales how strongly the modelled
   * contact temperature softens the coefficients (see THERMAL_* and
   * StringSim.tickComplete); 0 leaves the classic velocity curve untouched.
   */
  thermal?: number;
}

export interface SimState {
  rms: number;
  slipRatio: number; // fraction of recent samples in slip phase (bowing texture)
  freq: number; // current fundamental implied by delay lengths
  bowing: boolean;
}

const MU_S = 0.8; // static friction coefficient
const MU_D = 0.3; // dynamic friction coefficient

// Thermal (plastic) friction. Rosin's friction is set by contact temperature,
// not sliding speed (Smith & Woodhouse 2000): the flash-contact heats while the
// string slips, the rosin softens and the friction falls — then recovers as the
// contact cools between slips. Because the heat lags the sliding by the (short)
// flash time constant, the coefficient the friction curve uses this sample
// depends on the RECENT slip history, not just the instantaneous velocity: the
// curve opens into a hysteresis loop. That lag damps the runaway that makes the
// velocity curve over-capture spurious regimes, so it stabilises attacks and
// widens the Helmholtz wedge. See MODEL_NOTES.md.
//
// Cheap lumped model (cf. the torsional note): one scalar contact temperature T
// per string, first-order like a Smoother. Heating during slip is the
// frictional power T += THERMAL_KHEAT · fFric · |vSlip|; cooling every sample is
// T -= T / tauCool. The DYNAMIC coefficient is softened by θ(T) = 1/(1 + β·T),
// falling with heat, and fed into the existing quadratic in place of the
// constant. We modulate only muD (the slip branch), not the muS stick threshold:
// softening the threshold destabilises working Helmholtz (a non-monotone capture
// hole, lost ponticello brightness), so — exactly as the torsional loss is gated
// to slip — this is too. The per-string `thermal` amount scales β (so it is a
// no-op at 0 and monotone above it). The faithful version would replace this
// single pole with the 1-D heat-diffusion memory kernel (~1/√t half-order
// memory) of a real contact — heavier, but a truer temperature history.
const THERMAL_TAU_S = 0.0004; // flash-contact cooling time constant (~0.4 ms)
const THERMAL_KHEAT = 2.0; // frictional-power -> temperature gain
const THERMAL_BETA = 1.0; // base coefficient-softening sensitivity (scaled by spec.thermal)

// Bow-speed gate for the attack-wedge effects (the torsional slip loss and the
// thermal softening). Both widen the Helmholtz CAPTURE region — that is what
// makes an attack lock the fundamental — and both belong to a bow drawn ACROSS
// the string. When the bow is instead dragged ALONG the string with almost no
// transverse motion, the tiny residual |vBow| (pointer jitter) is all the model
// sees, and a widened capture region lets that jitter lock the string into a
// spurious, sustained, over-loud pitched tone — where a real motionless-across
// bow leaves the string silent (only the hair sounds). So fade both effects out
// below WEDGE_V1: a genuine stroke (|vBow| well above it, slow bows included)
// keeps the full wedge, while a near-stationary transverse contact reverts to
// the plain friction curve. The window sits far under real playing speeds
// (~0.05–0.3) yet above jitter, and — because it only scales the torsional/
// thermal DEVIATIONS, which are zero when those amounts are zero — it leaves the
// torsional = 0 / thermal = 0 behaviour byte-for-byte unchanged. See MODEL_NOTES.
const WEDGE_V0 = 0.005; // below this transverse speed: no wedge (plain curve)
const WEDGE_V1 = 0.02; // at/above this: full torsional + thermal wedge

// Finite bow-hair width. A real bow contacts the string over a ribbon of hair
// (~8-10 mm) rather than a mathematical point, so the friction at any instant
// responds to the string velocity *averaged over the contact patch*, not to a
// single sample of it. The Helmholtz corner takes a finite time to sweep under
// that patch; averaging over that time rounds the corner the friction curve
// sees, which spreads (averages) the moment of slip across the patch and
// suppresses the secondary slip-within-a-period that captures the octave
// (double-slip). See Pitteroff & Woodhouse, and MODEL_NOTES.md ("Why the model
// is more capture-prone").
//
// The averaging is CENTRE-WEIGHTED (a triangular window, RibbonAverager): the
// hair presses hardest at the ribbon's middle, and a triangle keeps far more of
// the bright sul-ponticello partials than a flat boxcar of the same span.
//
// The width is a fraction of the OPEN-string length. The patch-crossing time in
// samples is the time for a transverse wave (speed c = 2·L·f0, constant along
// the string) to cross that fixed patch: w·(2L)/c = w/(2·f0) seconds =
// w·fs/(2·f0) samples — independent of where the string is stopped or bowed,
// because the patch and the wave speed are both fixed. So each string carries
// one constant window; low strings (slow, long) average over more samples than
// the high ones, exactly as a fixed-width bow behaves in practice. That span is
// the triangle's base (2L-1); the RibbonAverager's boxcar half-length L is half
// of it.
// Default OFF (point contact): the ribbon averaging softens the low strings'
// attack a touch and, leaned on hard near the bridge, can tip a low open string
// into a surface whistle — so the model ships as the original single-point
// friction and the ribbon is opt-in via bowHairWidth (the "Hair" control), the
// bow's tilt from edge (0) to flat. ~0.05 is where double-slip suppression
// becomes audible; MAX_HAIR_SAMPLES caps the safe span above that.
const BOW_HAIR_WIDTH = 0; // default: point contact (a fraction of the open-string length when set)
// Ceiling on the patch span (triangular base). The averaging over-rounds the
// fundamental's own corner and flips the string into a bright, over-smoothed
// pseudo-flautando once the boxcar half-length reaches 5 — on every string. A
// span of 7 caps the half-length at 4 (the last well-behaved value), so no
// bowHairWidth, however large, can push any string over that edge: the low
// strings saturate here while the shorter/faster high strings never reach it.
const MAX_HAIR_SAMPLES = 7;
const MAX_HAIR_HALF = Math.ceil((MAX_HAIR_SAMPLES + 1) / 2); // = 4, boxcar buffer size

// Terminating-node positions (fraction of the string from the nut) over which
// a stopped finger releases into the open string as it nears the nut. With the
// node at or below NUT_OPEN the string is fully open; the damping ramps back to
// a firm stop over the next NUT_FADE. Kept well clear of the first real stopped
// note (node ~0.056, a semitone above the open string).
const NUT_OPEN = 0.015;
const NUT_FADE = 0.03;

// Pluck loudness compensation. A low pizzicato carries as much signal energy as
// a high one, but the ear's low-frequency roll-off (equal-loudness) makes it
// read far quieter — an open G thuds where the E rings. Tilt the pluck
// amplitude up toward the low end so the strings sound balanced, anchored at
// PLUCK_LF_REF_HZ (~the top string) with a gentle exponent, never attenuating
// (min gain 1) so the bright top strings are untouched, and capped so a very
// low string can't overdrive the model.
const PLUCK_LF_REF_HZ = 660;
const PLUCK_LF_TILT = 0.5;
const PLUCK_LF_MAX = 2.0;

/** Violin-ish modal body resonances: [freq Hz, Q, gain]. */
const BODY_MODES: ReadonlyArray<[number, number, number]> = [
  [275, 9, 1.5], // "breathing" A0 mode
  [460, 8, 1.2],
  [550, 11, 1.0],
  [700, 7, 0.9],
  [1000, 7, 0.8],
  [1400, 8, 0.7],
  [2600, 6, 0.85],
  [3400, 7, 0.5],
];

/**
 * Bridge force -> ear: DC blocking, the modal body-filter bank, dry/wet mix,
 * master gain, a gentle safety saturation, and 512-sample RMS metering of
 * the result. The ONE output chain for both the solo StringSim path (tests,
 * offline harnesses) and the whole instrument (ViolinSim, which feeds it the
 * summed bridge force of all four strings) — so a tweak to the mix or
 * saturation cannot diverge between the two.
 */
export class BodyOutput {
  bodyMix = 0.75; // 0 = raw string, 1 = full body filter
  masterGain = 0.9;

  private dc = new DCBlocker();
  private body: BiquadBP[] = [];
  private rmsAcc = 0;
  private rmsVal = 0;
  private rmsCount = 0;

  constructor(sampleRate: number) {
    for (const [f, q, g] of BODY_MODES) {
      const bq = new BiquadBP();
      bq.set(f, q, g, sampleRate);
      this.body.push(bq);
    }
  }

  /** One sample: bridge force in, speaker sample out. */
  process(force: number): number {
    const dry = this.dc.process(force);
    let wet = 0;
    for (let i = 0; i < this.body.length; i++) wet += this.body[i].process(dry);
    let y = this.masterGain * ((1 - this.bodyMix) * dry + this.bodyMix * (0.32 * dry + wet));
    // gentle safety saturation
    y = Math.tanh(1.4 * y) * 0.72;

    this.rmsAcc += y * y;
    this.rmsCount++;
    if (this.rmsCount >= 512) {
      this.rmsVal = Math.sqrt(this.rmsAcc / this.rmsCount);
      this.rmsAcc = 0;
      this.rmsCount = 0;
    }
    return y;
  }

  get rms(): number {
    return this.rmsVal;
  }

  clear(): void {
    this.dc.clear();
    for (const b of this.body) b.clear();
  }
}

export class StringSim {
  readonly fs: number;

  // --- public control inputs (set freely from outside; smoothed internally)
  bowOn = false;
  bowVelocity = 0; // signed, ~[-0.6, 0.6]
  bowForce = 0.3; // >= 0, useful range ~[0.02, 1.5]
  bowPosition = 0.88; // 0 = nut, 1 = bridge (clamped to playable range)
  fingerOn = false;
  fingerPosition = 0.3; // fingertip CENTRE; 0 = nut, 1 = bridge (may go slightly
  // negative when the finger slides up onto the nut). The terminating/damping
  // node sits up to one FINGER_RADIUS toward the bridge — see fingerNode().
  fingerPressure = 0; // 0 = off, ~0.1 = harmonic touch, 1 = firm stop
  /** True when a bow or plucking implement rides at bowPosition (a solo
   * string always: the contact-point colour applies to plucks and to the
   * ring after a bow lift alike). ViolinSim clears it on unplayed strings —
   * nothing touches them, so their bridge filter must stay at the string's
   * neutral darkness rather than follow the player's bow as it moves over a
   * DIFFERENT string, which would otherwise alter (and, via the filter's
   * phase delay, subtly retune) a freely ringing string's decay. */
  contact = true;
  bodyMix = 0.75; // 0 = raw string, 1 = full body filter
  masterGain = 0.9;
  /** Bow-hair ribbon width, as a fraction of the OPEN-string length. Sets the
   * contact-patch averaging window at the bow junction (see BOW_HAIR_WIDTH).
   * 0 collapses to a point contact — the classic single-sample friction model.
   * Constant per instrument in normal use; exposed so a point-vs-ribbon
   * comparison is testable and a bow can, in principle, be re-haired. */
  bowHairWidth = BOW_HAIR_WIDTH;

  private spec: StringSpec = {
    f0: 220,
    darkness: 0.3,
    loss: 0.4,
    stiffness: 0.2,
    nonlinearity: 0.15,
    torsional: 0,
    thermal: 0,
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
  private nutCoeff = 0.997;

  // Lossy torsional shunt at the bow (see setString / tickComplete). During a
  // slip the bow drives the string surface, which twists as well as translates;
  // torsTransFrac = 1/(1 + torsional) is the fraction of the slip that reaches
  // the transverse waveguide, the rest being twist the (heavily damped)
  // torsional mode dissipates. It is 1 when spec.torsional is 0, recovering the
  // pure-transverse bow. Applied ONLY in the slip branch: the stick phase — and
  // with it every sustained, slow-bow, and over-pressed regime — is left
  // exactly as it was, so those effects are untouched.
  private torsTransFrac = 1;

  // Thermal (plastic) friction (see THERMAL_* and tickComplete). `temp` is the
  // lumped contact temperature T; `thermalBeta` is the per-string softening
  // sensitivity (THERMAL_BETA · spec.thermal, so 0 when thermal is off);
  // `thermalCool` is the per-sample cooling fraction 1/(tauCool in samples).
  private temp = 0;
  private thermalBeta = 0;
  private thermalCool = 0;
  // instrumentation for the friction-velocity hysteresis loop: the signed
  // transverse friction force and the signed bow-string sliding velocity from
  // the last bow sample (see bowFriction / bowSlipVel).
  private fricLast = 0;
  private slipVelLast = 0;

  // bridge force -> body filter -> ear, for the solo (uncoupled) path
  private output: BodyOutput;

  // pluck pulse state
  private pluckSamplesLeft = 0;
  private pluckLen = 0;
  private pluckAmp = 0;
  private pluckPhase = 0;

  // finite bow-hair width: a centre-weighted (triangular) average of the free
  // bow-point velocity over the contact patch (see BOW_HAIR_WIDTH). A half-
  // length of 1 collapses to the point-contact model exactly.
  private ribbon = new RibbonAverager(MAX_HAIR_HALF);
  private hairHalf = 1;

  // metering (rms lives in the BodyOutput; slip is bow-junction-local)
  private slipAcc = 0;
  private slipVal = 0;
  private slipCount = 0;

  // slow EMA of squared string amplitude, drives tension-modulation detune
  private amp2 = 0;
  private amp2Coeff = 0;

  // block-level targets computed by beginBlock()
  private tgtA = 0;
  private tgtB = 0;
  private tgtC = 0;
  private tgtRf = 0;
  private tgtVel = 0;
  private tgtForce = 0;
  private vcKnee = 0.015;

  // per-sample intermediates carried from tickBridgeRead() to tickComplete()
  private sAtNut = 0;
  private sAFng = 0;
  private sBFng = 0;
  private sBBow = 0;
  private sCBow = 0;
  private sAtBridge = 0;
  private sBridgeR = 0;

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

    this.output = new BodyOutput(sampleRate);

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
    // torsional admittance as a fraction of the transverse admittance; the
    // transverse share of a slip is then 1/(1 + torsional).
    const tors = Math.max(0, spec.torsional ?? 0);
    this.torsTransFrac = 1 / (1 + tors);
    // thermal friction: β scaled by the per-string amount (0 => θ ≡ 1, off);
    // cooling fraction from the flash-contact time constant in samples.
    this.thermalBeta = THERMAL_BETA * Math.max(0, spec.thermal ?? 0);
    this.thermalCool = 1 / Math.max(1, THERMAL_TAU_S * this.fs);
    this.updateHairWindow();
  }

  /** Recompute the bow-hair averaging window from bowHairWidth and the open-
   * string pitch; the patch-crossing span is constant per string regardless of
   * stopping (see BOW_HAIR_WIDTH). The span is the triangular window's base;
   * the RibbonAverager's boxcar half-length is half of it. */
  private updateHairWindow(): void {
    const span = Math.round((this.bowHairWidth * this.fs) / (2 * this.spec.f0));
    const base = Math.min(MAX_HAIR_SAMPLES, Math.max(1, span));
    this.hairHalf = Math.max(1, Math.round((base + 1) / 2));
    this.ribbon.setHalfLength(this.hairHalf);
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
    // the sounding fundamental (round-trip length), needed for a period-keyed
    // width and for the low-frequency loudness tilt below
    const total = this.dA.value + this.dB.value + this.dC.value;
    const comp = this.bridgeLP.phaseDelay() + this.disp1.delayAtDC() + this.disp2.delayAtDC();
    const vibLen = this.effectiveRf() > 4 ? this.dB.value + this.dC.value : total;
    const period = 2 * vibLen + comp;
    let len = Math.round((widthMs / 1000) * this.fs);
    if (periodFrac > 0) len = Math.round(periodFrac * period);
    this.pluckLen = Math.max(8, len);
    this.pluckSamplesLeft = this.pluckLen;
    // a gentle width compensation keeps a mellow (wider) pizz from dropping too
    // far below a sharp plectrum stroke of the same force
    const widthMsActual = (this.pluckLen / this.fs) * 1000;
    const widthComp = 1 + 0.06 * Math.max(0, widthMsActual - 0.8);
    // boost the low strings so they read as present as the highs (see the
    // PLUCK_LF_* notes) — a √-frequency tilt anchored at the top string
    const freq = this.fs / Math.max(1, period);
    const lfGain = Math.min(PLUCK_LF_MAX, Math.max(1, Math.pow(PLUCK_LF_REF_HZ / freq, PLUCK_LF_TILT)));
    this.pluckAmp = 0.55 * Math.min(1.5, Math.max(0, force)) * widthComp * lfGain;
    this.pluckPhase = 0;
  }

  /** Instantly silence the string. */
  reset(): void {
    for (const d of [this.aR, this.aL, this.bR, this.bL, this.cR, this.cL]) d.clear();
    this.bridgeLP.clear();
    this.disp1.clear();
    this.disp2.clear();
    this.output.clear();
    this.pluckSamplesLeft = 0;
    this.amp2 = 0;
    this.temp = 0;
    this.fricLast = 0;
    this.slipVelLast = 0;
    this.ribbon.clear();
  }

  getState(): SimState {
    const total = this.dA.value + this.dB.value + this.dC.value;
    const comp = this.bridgeLP.phaseDelay() + this.disp1.delayAtDC() + this.disp2.delayAtDC();
    const vibLen = this.effectiveRf() > 4 ? this.dB.value + this.dC.value : total;
    const roundTrip = 2 * vibLen + comp;
    return {
      rms: this.output.rms,
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
    // As the terminating node (see fingerNode) reaches the nut, fade the
    // damping out so the full string length speaks (the true open pitch)
    // instead of terminating a hair short and sounding slightly sharp — the
    // min-segment clamp in delayTargets() would otherwise hold the junction
    // ~2 samples off the nut. This also releases the stop smoothly into the
    // open string as the finger slides up, like a glissando from the open note.
    const nutFade = Math.min(1, Math.max(0, (this.fingerNode() - NUT_OPEN) / NUT_FADE));
    return rf * nutFade;
  }

  /** Where the finger acts on the string (unclamped; fraction from the nut).
   * A firm press flattens the fleshy fingertip against the board and the note
   * speaks from the *bridge-side edge* of the contact patch, one FINGER_RADIUS
   * past the centre; a light harmonic touch barely dents the flesh, so the
   * string is damped under the finger's *middle*. The offset scales with
   * pressure between those extremes — the flesh flattens as the finger leans
   * in — which also keeps a mode switch under a latched finger continuous. */
  private fingerNode(): number {
    return this.fingerPosition + FINGER_RADIUS * Math.min(1, Math.max(0, this.fingerPressure));
  }

  private clampedPositions(): [number, number] {
    // Slid up onto the nut the node reaches 0 and the string speaks open. The
    // node may run well past the fingerboard's end toward the bridge — the
    // pitch (and, for a light touch, the selected flageolet) keeps rising into
    // the very high register up to MAX_STOP_NODE, where the bow only just fits.
    const pf = Math.min(MAX_STOP_NODE, Math.max(0, this.fingerNode()));
    const pb = Math.min(0.99, Math.max(pf + 0.05, this.bowPosition));
    return [pf, pb];
  }

  private delayTargets(): [number, number, number] {
    const comp = this.bridgeLP.phaseDelay() + this.disp1.delayAtDC() + this.disp2.delayAtDC();
    // tension modulation: vibration amplitude stretches the string slightly,
    // raising the pitch — shorten all segments by the same factor.
    // Only amplitudes beyond ordinary playing stretch the string audibly:
    // measured bridge-wave amp² is ~0.11 for a gentle sustained stroke and
    // ~0.17–0.21 driven hard, so the knee sits just under the former and the
    // window is scaled to keep the old ceiling (nl × 0.033, ~+20 cents on the
    // G) for the hardest strokes. (The previous knee/cap of 0.012/0.045 sat
    // entirely BELOW ordinary levels, so every bowed note — however gentle —
    // carried the full detune: always ~9–20 cents sharp of nominal, which
    // also kept the played note off the open strings' sympathetic resonances
    // whenever the bow was moving.)
    const excess = 0.165 * Math.max(0, Math.min(0.3, this.amp2) - 0.1);
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

  /** Compute the per-block control targets. Call once before a run of
   * tickBridgeRead()/tickComplete() pairs (process() does this itself). */
  beginBlock(): void {
    this.updateHairWindow();
    if (this.contact) {
      const beta = 1 - this.clampedPositions()[1]; // bow-bridge distance fraction

      // contact-point colour: near the bridge the Helmholtz corner stays sharp
      // (less Cremer rounding) and the bridge passes more upper partials; over
      // the fingerboard the tone rounds off and darkens
      this.vcKnee = 0.015 + 0.19 * beta; // friction-curve knee
      this.bridgeLP.a = Math.min(0.6, (0.12 + 0.5 * this.spec.darkness) * (0.45 + 2.1 * beta));
    } else {
      // untouched string: plain termination at the string's own darkness
      this.bridgeLP.a = 0.12 + 0.5 * this.spec.darkness;
    }

    const [tA, tB, tC] = this.delayTargets();
    this.tgtA = tA;
    this.tgtB = tB;
    this.tgtC = tC;
    this.tgtRf = this.effectiveRf();
    this.tgtVel = this.bowOn ? this.bowVelocity : 0;
    this.tgtForce = this.bowOn ? this.bowForce : 0;
  }

  /** Phase 1 of one sample: advance the delay smoothers, read the travelling
   * waves off the lines and push the wave arriving at the bridge through the
   * termination's loss filter. Returns that loss-filtered wave — the signal
   * this string hands to the bridge. A shared bridge junction (ViolinSim)
   * collects it from every string before any reflection is written back;
   * tickComplete() must follow exactly once per call. */
  tickBridgeRead(): number {
    const dA = this.dA.tick(this.tgtA);
    const dB = this.dB.tick(this.tgtB);
    const dC = this.dC.tick(this.tgtC);

    // --- waves arriving at each end/junction
    this.sAtNut = this.aL.read(dA);
    this.sAFng = this.aR.read(dA);
    this.sBFng = this.bL.read(dB);
    this.sBBow = this.bR.read(dB);
    this.sCBow = this.cL.read(dC);
    const atBridge = this.cR.read(dC);
    this.sAtBridge = atBridge;

    // amplitude tracker for the tension-modulation detune
    this.amp2 += this.amp2Coeff * (atBridge * atBridge - this.amp2);

    this.sBridgeR = this.bridgeLP.process(atBridge);
    return this.sBridgeR;
  }

  /** Phase 2 of one sample: junctions, excitation, and the delay-line writes.
   * `bridgeIn` is the wave the shared bridge junction transmits INTO this
   * string from its siblings (0 when the string stands alone). */
  tickComplete(bridgeIn: number): void {
    const rf = this.rfSm.tick(this.tgtRf);
    const vBow = this.bowVelSm.tick(this.tgtVel);
    // small force noise gives the bow its breathy texture
    const fb = this.bowForceSm.tick(this.tgtForce) * (1 + 0.08 * (Math.random() - 0.5));

    // --- nut reflection
    const nutOut = -this.nutCoeff * this.sAtNut;

    // --- bridge reflection (loss + stiffness) plus cross-string transmission
    const bridgeOut = -this.disp2.process(this.disp1.process(this.sBridgeR)) + bridgeIn;

    // --- finger junction (damper of resistance rf, Z = 1 both sides)
    const tCoef = 2 / (2 + rf);
    const vF = tCoef * (this.sAFng + this.sBFng);
    const fngToB = vF - this.sBFng;
    const fngToA = vF - this.sAFng;

    // --- bow junction: stick-slip friction with a lossy torsional shunt and
    // optional thermal (temperature-dependent) coefficients.
    // The bow rides on the string SURFACE, which twists as well as translates.
    // Torsion matters during a SLIP: the sudden release spins the string, and
    // that twist — heavily damped, so treated as a pure loss — carries off part
    // of the slip instead of launching it all as a transverse wave. So a slip
    // moves the transverse junction only torsTransFrac = 1/(1 + torsional) of the
    // way from the incoming (free) velocity toward the solved slip velocity;
    // the remainder is dissipated in twist. This puts a loss channel right at
    // the bow point, where an attack's aperiodic junk lives, damping the
    // spurious double-slip/whistle regimes and widening the Guettler attack
    // wedge. The STICK phase is deliberately left untouched (vJ = vBow, same
    // threshold), so sustained tone, slow bows, and over-pressure — all
    // stick-dominated — keep their existing behaviour; and torsional = 0 makes
    // torsTransFrac = 1, recovering the pure-transverse junction exactly.
    //
    // Thermal friction (spec.thermal > 0) layers on top: the contact flash-heats
    // as it slips, softening the DYNAMIC friction coefficient muD via θ(T) below,
    // with the heat lagging the sliding (a hysteresis loop). Like the torsional
    // shunt it is a slip-side effect — and, mirroring that choice, it modulates
    // only the slip branch's coefficient (muD), NOT the static stick threshold
    // muS: softening the threshold would let working Helmholtz break into slip
    // too easily (measurably: a non-monotone capture hole and lost ponticello
    // brightness), whereas softening only the dynamic branch widens the attack
    // wedge cleanly and leaves the stick-dominated extremes intact. Both effects
    // compose, and each is a no-op at its 0 setting. See MODEL_NOTES.md.
    const bBow = this.sBBow;
    const cBow = this.sCBow;
    const vh = bBow + cBow; // free transverse velocity at the bow point
    // finite bow-hair width: centre-weighted average of the free velocity over
    // the contact patch. The friction curve reacts to this smeared velocity
    // (vhBar) rather than the point value, spreading the moment of slip across
    // the patch (see RibbonAverager); the resulting increment is applied to the
    // TRUE point velocity vh. A half-length of 1 leaves vhBar = vh (point
    // contact, the default), recovering the plain torsional junction exactly.
    const vhBar = this.ribbon.process(vh);
    // Thermal (plastic) friction: soften the DYNAMIC friction coefficient by
    // θ(T), where T is the lumped contact temperature carried between samples
    // (see THERMAL_*). θ = 1/(1 + β·T) drops with heat, so muD falls as the
    // contact flash-heats and recovers as it cools — and because T lags the
    // sliding, the slip branch traces a hysteresis loop rather than a fixed
    // velocity curve. thermalBeta = 0 (thermal off) makes θ ≡ 1, so muD is the
    // plain constant and every downstream test is byte-for-byte the classic
    // curve. The STATIC coefficient muS (the stick threshold) is deliberately
    // left unmodulated — see the note in tickComplete below and MODEL_NOTES.md.
    // Wedge activation: 0 for a near-stationary transverse contact (bow dragged
    // along the string), rising to 1 for a genuine stroke, so the torsional and
    // thermal wedge-widening only engage when the bow is actually moving across
    // the string (see WEDGE_V0/WEDGE_V1). At wedge = 0 both effects vanish and
    // the friction is the plain velocity curve, so a vertical drag no longer
    // captures the string into a sustained tone.
    const av = Math.abs(vBow);
    const wedge = av <= WEDGE_V0 ? 0 : av >= WEDGE_V1 ? 1 : (av - WEDGE_V0) / (WEDGE_V1 - WEDGE_V0);
    // torsional transverse fraction, faded toward 1 (no twist loss) as the wedge
    // closes; = 1 exactly when spec.torsional is 0, whatever the wedge.
    const torsFrac = 1 - wedge * (1 - this.torsTransFrac);
    const muS = MU_S;
    let muD = MU_D;
    if (this.thermalBeta > 0) muD = MU_D / (1 + this.thermalBeta * wedge * this.temp);
    let vJ = vh;
    let slipping = 0;
    let fExc = 0; // signed transverse velocity excursion vJfree − vh (½ the force)
    let vSlip = 0; // signed bow-string sliding velocity = vBow − vJfree
    if (fb > 1e-4) {
      const k = 0.5 * fb; // F/(2Z)
      const d = vBow - vhBar;
      const ad = Math.abs(d);
      if (ad <= k * muS) {
        // stick: string moves with the bow (torsion is a slip-only loss). With
        // a finite patch this rides the averaged velocity, so vJ equals vBow
        // exactly only at hair width 0 (vhBar = vh). No sliding, so no heating.
        vJ = vh + (vBow - vhBar);
        fExc = vBow - vhBar; // held-stick force excursion (no sliding: vSlip = 0)
      } else {
        // slip: solve s^2 + B s + C = 0 for slip speed s = |vBow - vJfree|
        const B = this.vcKnee - ad + k * muD;
        const C = this.vcKnee * (k * muS - ad); // < 0 here => one positive root
        const s = 0.5 * (-B + Math.sqrt(B * B - 4 * C));
        const sgn = Math.sign(d);
        // free transverse target is vBow - sign(d)·s, measured against the
        // patch-averaged velocity; the torsional shunt keeps only torsTransFrac
        // of that excursion, dissipating the rest as twist.
        vJ = vh + sgn * (ad - s) * torsFrac;
        slipping = 1;
        // Frictional heating (thermal only): power = friction force × sliding
        // speed, both in the patch-averaged sense the decision above used. The
        // friction force at the contact is the FULL (pre-torsional) transverse
        // excursion 2Z·(ad − s); the sliding speed is s. Heat lags this by the
        // flash time constant, which is the hysteresis.
        // scale the heating by the same wedge that gates the softening, so the
        // contact temperature only banks heat while the thermal effect is
        // actually engaged — a near-stationary contact (wedge = 0) neither
        // softens nor heats, and the two stay consistent across the gate ramp.
        if (this.thermalBeta > 0) this.temp += THERMAL_KHEAT * 2 * (ad - s) * s * wedge;
        fExc = sgn * (ad - s);
        vSlip = sgn * s;
      }
    }
    // Cooling every sample (thermal only): first-order relaxation of the flash
    // contact. Runs in stick and silence too, so heat bleeds off between slips —
    // that recovery is the other half of the hysteresis.
    if (this.thermalBeta > 0) this.temp -= this.temp * this.thermalCool;
    this.fricLast = 2 * fExc; // 2Z·excursion = the transverse friction force
    this.slipVelLast = vSlip;
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

    this.slipAcc += slipping;
    this.slipCount++;
    if (this.slipCount >= 512) {
      this.slipVal = this.slipAcc / this.slipCount;
      this.slipAcc = 0;
      this.slipCount = 0;
    }
  }

  /** The raw wave that arrived at the bridge this sample (the string's
   * contribution to the total bridge force) — valid after tickBridgeRead(). */
  get bridgeForce(): number {
    return this.sAtBridge;
  }

  /** Signed transverse friction force injected at the bow last sample (2Z times
   * the velocity excursion). Instrumentation for the friction–velocity
   * hysteresis loop; pair with {@link bowSlipVel}. Valid after tickComplete(). */
  get bowFriction(): number {
    return this.fricLast;
  }

  /** Signed bow-string sliding velocity last sample (0 while stuck). The x-axis
   * of the friction–velocity loop that thermal friction opens. */
  get bowSlipVel(): number {
    return this.slipVelLast;
  }

  /** Lumped bow-contact temperature (thermal friction state); 0 when thermal is
   * off. Exposed for the thermal-model harnesses. */
  get contactTemp(): number {
    return this.temp;
  }

  /** Slow (~30 ms) envelope of the bridge-wave amplitude — how strongly the
   * string is vibrating right now, independent of the output chain. */
  amplitude(): number {
    return Math.sqrt(Math.max(0, this.amp2));
  }

  /** Render `out.length` mono samples (single string, own body filter). */
  process(out: Float32Array): void {
    this.beginBlock();
    this.output.bodyMix = this.bodyMix;
    this.output.masterGain = this.masterGain;
    for (let n = 0; n < out.length; n++) {
      this.tickBridgeRead();
      this.tickComplete(0);
      out[n] = this.output.process(this.sAtBridge);
    }
  }
}
