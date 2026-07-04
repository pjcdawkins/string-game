/**
 * Visual model of the string. Deliberately *not* the audio model: the real
 * vibration is hundreds of Hz, so we render a slow-motion, pedagogically useful
 * caricature — but, like a real string (and the audio engine), it is a *single*
 * travelling-wave object (see {@link WaveString}) rather than a bag of separate
 * drawing modes. Every regime is the same string under a different excitation or
 * boundary condition:
 *
 * - a pluck/grab release is an initial triangle that splits, travels and
 *   reflects — so plucking at 1/4 shows the missing-4th-harmonic motion for
 *   free, and the ring-down is just that motion decaying;
 * - while bowing we *write* the Helmholtz corner onto the string each frame
 *   (direction following the bow stroke); lifting the bow simply stops writing,
 *   and the corner already on the string rings down on its own — no second
 *   representation to crossfade or cancel against;
 * - a light finger touch bleeds energy at the node, so only flageolets with a
 *   node there survive — the touched harmonic emerges from the same string;
 * - a firm stop moves the nut-side termination under the finger (confining the
 *   vibration to the bridge side) and the string visibly depresses (in z).
 */
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import * as THREE from "three";
import { WaveString } from "./waveString";
import { FINGER_RADIUS, MAX_STOP_NODE } from "../state";
import { laneX, LANE_LINEWIDTH } from "./lanes";
import type { SceneTheme } from "./theme";

export const NPTS = 160;

// ring-down character of the freely vibrating string (caricature knobs). The
// defaults govern a bow's release ring-down, which already reads naturally; a
// pluck rings down from a sharp seeded corner instead of the bow's smooth
// analytic shape, so it gets its own, gentler set (below) — rounder and
// shorter, so the "lightning bolt" softens into a curve and settles sooner.
const REFLECT_LOSS = 0.86; // amplitude kept per end reflection (lower = shorter ring)
const HF_LOSS = 0.12; // extra damping of high modes per reflection (duller decay)
const NODE_LOSS = 0.45; // energy bled per step at a touched flageolet node

// pluck ring-down: shorter (a pizz note is a brief bloom, not a long sing) and
// with markedly more HF loss so the travelling corner keeps rounding as it
// rings rather than staying a stark kink.
const PLUCK_REFLECT_LOSS = 0.74;
const PLUCK_HF_LOSS = 0.34;
// a pizzed harmonic is seeded as its clean standing mode, so it rings down like
// a bowed flageolet: a moderate, un-node-damped decay that stays long enough to
// read the curve (node damping is redundant here and would eat the seeded mode).
const HARMONIC_PLUCK_LOSS = 0.9;
// binomial smoothing passes applied to the seeded triangle so the ring-down
// starts as a curved bend instead of an infinitely sharp corner.
const PLUCK_ROUND_PASSES = 26;
// amplitude of a pizzed harmonic's seeded standing mode, relative to the pluck
// displacement — a flageolet speaks softer than a firmly stopped note.
const HARMONIC_PLUCK_SCALE = 0.6;

// driven bowed-flageolet swing is seeded a touch hotter than the corner regime so
// the standing mode reads clearly; the glow guard must use the same scale or the
// bow wash-out fix regresses silently (seeded wave and glow amplitude drift apart)
const BOW_HARMONIC_AMP_SCALE = 1.4;

export interface GrabState {
  p: number; // 0..1 from nut
  dx: number; // world-unit lateral displacement
}

export interface VisualInputs {
  grabbed: GrabState | null;
  fingerOn: boolean;
  fingerPos: number;
  fingerPressure: number;
  bowing: boolean;
  bowEngaged: boolean;
  bowVelSign: number;
  rms: number;
  slipRatio: number;
  slowMoHz: number;
}

export class VisualString {
  readonly group = new THREE.Group();
  private line: Line2;
  private glow: Line2;
  private lineMat: LineMaterial;
  private glowMat: LineMaterial;
  private positions = new Float32Array(NPTS * 3);

  private readonly yTop: number;
  private yLen: number;
  // the lane this string occupies (0 = IV/lowest, leftmost); its rest line
  // fans with s like the idle strings, and the vibration displaces around it
  private lane = 0;

  private wave = new WaveString(NPTS);
  private vibAmp = 0; // smoothed drive amplitude (follows audio RMS while bowing)
  private glowAmp = 0; // envelope of the actual string motion (drives the glow)
  private helmPhase = 0; // bowed corner travel phase, cycles
  private harmPhase = 0; // bowed-flageolet standing-mode swing phase, cycles
  // true while a free ring-down is a pluck's (vs a bow release's), so the
  // ring-down can use the gentler pluck loss/rounding set
  private plucked = false;
  // whether the current pluck seeded a harmonic standing mode — latched at
  // release, since the touching finger may lift while the harmonic still rings
  // (as a real flageolet does), and the ring-down must keep its long harmonic
  // decay rather than follow the now-cleared live selection
  private pluckedHarmonic = false;
  // harmonic selected by a light touch, cached each frame so a pizz released
  // between frames can seed the clean standing mode (see pluckVisual)
  private harmMode = 0;

  // theme-dependent glow treatment (see ./theme.ts): additive halo on dark,
  // normal-blended deeper colour on light (additive is invisible there)
  private glowLightness = 0.62;
  private glowOpacityScale = 1;

  constructor(yTop: number, yBottom: number) {
    this.yTop = yTop;
    this.yLen = yTop - yBottom;

    this.lineMat = new LineMaterial({
      color: 0xd8dee9,
      linewidth: 2.6,
      worldUnits: false,
    });
    this.glowMat = new LineMaterial({
      color: 0x86c5ff,
      linewidth: 9,
      worldUnits: false,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const geo = new LineGeometry();
    const geo2 = new LineGeometry();
    this.fillStraight();
    geo.setPositions(Array.from(this.positions));
    geo2.setPositions(Array.from(this.positions));
    this.line = new Line2(geo, this.lineMat);
    this.glow = new Line2(geo2, this.glowMat);
    this.group.add(this.glow);
    this.group.add(this.line);
  }

  setResolution(w: number, h: number): void {
    this.lineMat.resolution.set(w, h);
    this.glowMat.resolution.set(w, h);
  }

  /** Move the string onto lane `idx`, ending on the bridge at `yBottom`
   * (the crown is lower toward its edges, so the outer lanes break over it
   * slightly below the middle ones). The gauge follows the lane: G heavy,
   * E fine. */
  setLane(idx: number, yBottom: number): void {
    this.lane = idx;
    this.yLen = this.yTop - yBottom;
    this.lineMat.linewidth = LANE_LINEWIDTH[idx];
  }

  setTheme(t: SceneTheme): void {
    this.lineMat.color.set(t.string);
    this.glowLightness = t.glowLightness;
    this.glowOpacityScale = t.glowOpacity;
    this.glowMat.blending = t.additiveGlow ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.glowMat.needsUpdate = true;
  }

  private fillStraight(): void {
    for (let i = 0; i < NPTS; i++) {
      const s = i / (NPTS - 1);
      this.positions[i * 3] = laneX(this.lane, s);
      this.positions[i * 3 + 1] = this.yTop - s * this.yLen;
      this.positions[i * 3 + 2] = 0;
    }
  }

  /** Pluck/grab release: seed the string and let it ring down as a pluck. */
  pluckVisual(p: number, dx: number, stoppedAt: number): void {
    this.plucked = true;
    this.pluckedHarmonic = this.harmMode > 0;
    const nutI = Math.round(stoppedAt * (NPTS - 1));
    this.wave.setTermination(nutI);
    if (this.harmMode > 0) {
      // pizzed harmonic: seed the clean standing mode directly, so the ring-down
      // is the same smooth curve a bowed flageolet shows — the harmonic's shape
      // reads at once, instead of emerging from a jagged, node-filtered triangle
      // transient (the old "chaotic lightning"). A light touch never firms the
      // stop, so the mode spans the whole open length.
      const seg = this.wave.segmentLength;
      const amp = dx * HARMONIC_PLUCK_SCALE;
      this.wave.seedProfile((i) =>
        amp * Math.sin(this.harmMode * Math.PI * ((i - nutI) / seg)),
      );
      return;
    }
    const seg = stoppedAt < 1 ? (p - stoppedAt) / (1 - stoppedAt) : 0.5;
    // seed at the full held displacement (pluck() peaks at exactly `amp`; the
    // half-per-rail split is internal). The held grab re-seeds pluck(seg, dx)
    // each frame, so the ring-down must start at the same dx or the string
    // visibly snaps to half height the instant it is released.
    this.wave.pluck(seg, dx);
    // round the sharp corner so the ring-down travels as a curved bend, not a
    // stark kink (the shape then propagates/reflects rigidly, staying rounded)
    this.wave.smooth(PLUCK_ROUND_PASSES);
  }

  update(dt: number, inp: VisualInputs): void {
    const firmStop = inp.fingerOn && inp.fingerPressure > 0.55;
    // the string is terminated / node-damped at the bridge-side edge of the
    // fleshy fingertip, a radius past its centre (fingerPos); the finger itself
    // (its depression well, below) still sits at the centre
    const node = Math.min(MAX_STOP_NODE, Math.max(0, inp.fingerPos + FINGER_RADIUS));
    const L0 = firmStop ? node : 0;
    const harmonicAt =
      inp.fingerOn && inp.fingerPressure > 0.02 && inp.fingerPressure <= 0.55
        ? node
        : 0;

    const nutIndex = Math.round(L0 * (NPTS - 1));
    this.wave.setTermination(nutIndex);
    const segLen = this.wave.segmentLength;

    // drive amplitude follows the live audio level (kept modest — the slow-mo
    // caricature reads better when the swing stays near the string)
    const targetAmp = Math.min(0.105, inp.rms * 1.13);
    this.vibAmp += (targetAmp - this.vibAmp) * Math.min(1, dt * 14);

    // overpressure = prolonged sticking (slip ratio collapses), not lots of slip
    const raucous = inp.bowing && inp.slipRatio < 0.04 && this.vibAmp > 0.0075;

    const grab = inp.grabbed;
    const sounding = inp.bowing && inp.slipRatio > 0.005 && this.vibAmp > 0.002;
    // a light touch selects the lowest flageolet with a node there; we damp that
    // node during free vibration and (when bowing) drive that standing mode
    const harmN = harmonicAt > 0 ? lowestNodeMode(harmonicAt) : 0;
    const nodeIndex = harmonicAt > 0 ? Math.round(node * (NPTS - 1)) : -1;
    // cache the live harmonic selection so a pizz released between frames can
    // seed its clean standing mode (see pluckVisual)
    this.harmMode = harmN;

    if (grab) {
      // held aside by hand: a static triangle (re-seeded each frame). On release
      // the input layer calls pluckVisual(), so this same shape starts ringing.
      this.plucked = false;
      const seg = L0 < 1 ? (grab.p - L0) / (1 - L0) : 0.5;
      this.wave.pluck(seg, grab.dx);
    } else if (sounding) {
      this.plucked = false;
      // bow drives the string: write its steady shape onto the same waveguide
      this.helmPhase = (this.helmPhase + dt * inp.slowMoHz) % 1;
      this.harmPhase += dt * inp.slowMoHz * Math.max(1, harmN);
      if (harmN > 0) {
        const swing =
          this.vibAmp * BOW_HARMONIC_AMP_SCALE * Math.cos(2 * Math.PI * this.harmPhase);
        this.wave.seedProfile((i) =>
          swing * Math.sin(harmN * Math.PI * ((i - nutIndex) / segLen)),
        );
      } else {
        this.seedCorner(inp.bowVelSign, nutIndex, segLen, raucous);
      }
    } else {
      // free vibration: the string rings down on its own (a touched node keeps
      // filtering the ring-down so a plucked/bowed flageolet decays as itself).
      // A pluck rings from a sharp seed rather than the bow's smooth shape, so it
      // uses the gentler pluck set — rounder and shorter — to soften the kink and
      // keep the note from wobbling on too long.
      const steps = 2 * segLen * inp.slowMoHz * dt;
      const pluckHarm = this.plucked && this.pluckedHarmonic;
      this.wave.advance(steps, {
        loss: pluckHarm ? HARMONIC_PLUCK_LOSS : this.plucked ? PLUCK_REFLECT_LOSS : REFLECT_LOSS,
        hfLoss: pluckHarm ? HF_LOSS : this.plucked ? PLUCK_HF_LOSS : HF_LOSS,
        // a pizzed harmonic is already the clean mode, so skip node filtering
        nodeIndex: pluckHarm ? -1 : nodeIndex,
        nodeLoss: NODE_LOSS,
      });
    }

    // glow follows the actual string motion (a slow-release envelope of the peak,
    // so it tracks the ring-down rather than the bow telemetry). While the bow
    // drives a steady shape, though, the instantaneous peak passes through zero
    // twice per cycle (a standing flageolet collapses to flat), which would
    // flicker the glow; so during driven modes use the phase-independent drive
    // amplitude (matching the seeded peak: 1.4·vibAmp flageolet, vibAmp corner),
    // and fall back to the live peak for plucks and the free ring-down.
    const peak = sounding
      ? this.vibAmp * (harmN > 0 ? BOW_HARMONIC_AMP_SCALE : 1)
      : this.wave.peakAbs();
    this.glowAmp = Math.max(peak, this.glowAmp * Math.exp(-dt * 2.2));

    const fingerDepth = inp.fingerOn ? Math.min(0.085, 0.1 * inp.fingerPressure) : 0;

    for (let i = 0; i < NPTS; i++) {
      const s = i / (NPTS - 1);
      const x = this.wave.displacement(i);
      let z = 0;

      // depression toward the fingerboard around the finger
      if (fingerDepth > 0) {
        const d = Math.abs(s - inp.fingerPos);
        if (d < 0.07) z = -fingerDepth * (1 - d / 0.07);
        else if (s < inp.fingerPos && firmStop) {
          // nut side of a firm stop sags very slightly toward the board
          z = -fingerDepth * 0.25 * (s / Math.max(0.02, inp.fingerPos));
        }
      }

      this.positions[i * 3] = laneX(this.lane, s) + x;
      this.positions[i * 3 + 1] = this.yTop - s * this.yLen;
      this.positions[i * 3 + 2] = z;
    }

    this.line.geometry.setPositions(Array.from(this.positions));
    this.glow.geometry.setPositions(Array.from(this.positions));
    this.glowMat.opacity =
      Math.min(0.55, this.glowAmp * 4.4 + (grab ? 0.12 : 0)) * this.glowOpacityScale;
    // skip the (full-length, 9px-wide) glow line entirely while inaudible —
    // a real saving on weak GPUs and software renderers
    this.glow.visible = this.glowMat.opacity > 0.01;
    // colour shifts warmer when the tone is raucous/crunchy
    this.glowMat.color.setHSL(raucous ? 0.04 : 0.58, 0.85, this.glowLightness);
  }

  /** Write the travelling Helmholtz corner onto the string for this frame. */
  private seedCorner(
    bowVelSign: number,
    nutIndex: number,
    segLen: number,
    raucous: boolean,
  ): void {
    const phi = this.helmPhase;
    let cornerPos: number;
    let cornerSign: number;
    if (phi < 0.5) {
      cornerPos = phi * 2;
      cornerSign = 1;
    } else {
      cornerPos = 2 - phi * 2;
      cornerSign = -1;
    }
    if (bowVelSign < 0) cornerSign = -cornerSign;
    const cp = Math.min(0.985, Math.max(0.015, cornerPos));
    const cornerH = cornerSign * 4 * cp * (1 - cp) * this.vibAmp;
    const grit = raucous ? this.vibAmp * 0.5 : 0;
    this.wave.seedProfile((i) => {
      const sigma = (i - nutIndex) / segLen;
      const h = sigma <= cp ? (cornerH * sigma) / cp : (cornerH * (1 - sigma)) / (1 - cp);
      return grit ? h + (Math.random() - 0.5) * grit : h;
    });
  }
}

/** Lowest standing mode (2..9) with an *interior* node at p, or 0 if none. */
function lowestNodeMode(p: number): number {
  for (let n = 2; n <= 9; n++) {
    // nearest node index of mode n; k=0 (nut) and k=n (bridge) are the trivial
    // endpoints, not flageolet nodes — without this guard sin(nπp)→0 as p→0|1
    // gives a false low-harmonic hit when the finger is near either end.
    const k = Math.round(n * p);
    if (k <= 0 || k >= n) continue;
    if (Math.abs(Math.sin(n * Math.PI * p)) < 0.2) return n;
  }
  return 0;
}
