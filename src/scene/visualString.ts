/**
 * Visual model of the string. Deliberately *not* the audio model: the real
 * vibration is hundreds of Hz, so we render a slow-motion, pedagogically
 * useful caricature driven by the audio engine's live RMS / slip telemetry:
 *
 * - while bowing in the stick-slip regime we draw true Helmholtz motion
 *   (a travelling corner riding a parabolic envelope — THE bowed-string
 *   visual), direction following the bow stroke;
 * - after plucks we draw a sum of standing-wave modes seeded by the pluck
 *   point (so plucking at 1/4 shows the missing-4th-harmonic shape);
 * - a light harmonic touch replaces the corner with the touched flageolet's
 *   standing mode — the string vibrates in n segments with a node damped
 *   under the finger — and filters any modal residue the same way;
 * - a firm stop confines vibration to the finger->bridge section and the
 *   string visibly depresses (in z) onto the fingerboard.
 */
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import * as THREE from "three";

export const NPTS = 160;
const N_MODES = 9;

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
  private readonly yLen: number;

  private modeAmp = new Float32Array(N_MODES);
  private modePhase = new Float32Array(N_MODES);
  private vibAmp = 0;
  private helmPhase = 0;

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

  private fillStraight(): void {
    for (let i = 0; i < NPTS; i++) {
      const s = i / (NPTS - 1);
      this.positions[i * 3] = 0;
      this.positions[i * 3 + 1] = this.yTop - s * this.yLen;
      this.positions[i * 3 + 2] = 0;
    }
  }

  /** Seed the visual modes from a pluck at position p with release deflection dx. */
  pluckVisual(p: number, dx: number, stoppedAt: number, harmonicAt: number): void {
    const L0 = stoppedAt;
    const sp = Math.min(0.98, Math.max(0.02, (p - L0) / (1 - L0)));
    for (let n = 1; n <= N_MODES; n++) {
      let a = (dx * 0.5 * Math.sin(n * Math.PI * sp)) / n;
      if (harmonicAt > 0) {
        const node = Math.abs(Math.sin(n * Math.PI * harmonicAt));
        a *= Math.max(0, 1 - node * 2.4);
      }
      this.modeAmp[n - 1] = a;
      this.modePhase[n - 1] = 0;
    }
  }

  update(dt: number, inp: VisualInputs): void {
    const L0 = inp.fingerOn && inp.fingerPressure > 0.55 ? inp.fingerPos : 0;
    const harmonicAt =
      inp.fingerOn && inp.fingerPressure > 0.02 && inp.fingerPressure <= 0.55
        ? inp.fingerPos
        : 0;

    // amplitude follows the real audio level (kept modest — the slow-mo
    // caricature reads better when the swing stays near the string)
    const targetAmp = Math.min(0.21, inp.rms * 2.25);
    this.vibAmp += (targetAmp - this.vibAmp) * Math.min(1, dt * 14);

    // which flageolet (if any) the touch selects: the lowest mode with a
    // node at the touch point — low harmonics show their shape most clearly
    const harmN = harmonicAt > 0 ? lowestNodeMode(harmonicAt) : 0;

    const sounding = inp.bowing && inp.slipRatio > 0.005 && this.vibAmp > 0.002;
    if (sounding) {
      this.helmPhase += dt * inp.slowMoHz;
      this.helmPhase -= Math.floor(this.helmPhase);
      if (harmN > 0) {
        // bowed flageolet: drive the touched standing mode instead of the
        // open-string corner, so the node under the finger is visible
        this.modeAmp[harmN - 1] = Math.max(this.modeAmp[harmN - 1], this.vibAmp * 0.6);
      } else {
        // keep some modal residue so lifting the bow leaves a ringing string
        for (let n = 1; n <= 4; n++) {
          this.modeAmp[n - 1] = Math.max(this.modeAmp[n - 1], (this.vibAmp * 0.7) / n);
        }
      }
    }
    const drawCorner = sounding && harmN === 0;

    // advance / decay modes
    for (let n = 1; n <= N_MODES; n++) {
      this.modePhase[n - 1] += dt * 2 * Math.PI * n * inp.slowMoHz;
      this.modeAmp[n - 1] *= Math.exp(-dt * (0.9 + 0.55 * n));
      if (harmonicAt > 0) {
        const node = Math.abs(Math.sin(n * Math.PI * harmonicAt));
        this.modeAmp[n - 1] *= Math.exp(-dt * node * 14);
      }
    }

    // overpressure = prolonged sticking (slip ratio collapses), not lots of slip
    const raucous = inp.bowing && inp.slipRatio < 0.04 && this.vibAmp > 0.0075;
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
    if (inp.bowVelSign < 0) cornerSign = -cornerSign;
    const cp = Math.min(0.985, Math.max(0.015, cornerPos));
    const cornerH = cornerSign * 4 * cp * (1 - cp) * this.vibAmp;

    const grab = inp.grabbed;
    const fingerDepth = inp.fingerOn ? Math.min(0.085, 0.1 * inp.fingerPressure) : 0;
    const modalScale = harmonicAt > 0 ? 1.6 : 1; // harmonics are quiet; keep them visible

    for (let i = 0; i < NPTS; i++) {
      const s = i / (NPTS - 1);
      let x = 0;
      let z = 0;

      // depression toward the fingerboard around the finger
      if (fingerDepth > 0) {
        const d = Math.abs(s - inp.fingerPos);
        if (d < 0.07) z = -fingerDepth * (1 - d / 0.07);
        else if (s < inp.fingerPos && inp.fingerPressure > 0.55) {
          // nut side of a firm stop sags very slightly toward the board
          z = -fingerDepth * 0.25 * (s / Math.max(0.02, inp.fingerPos));
        }
      }

      // vibrating-region coordinate
      const sigma = Math.min(1, Math.max(0, (s - L0) / (1 - L0)));
      const leak = s < L0 ? 0.06 : 1;

      if (grab) {
        const gp = Math.min(0.97, Math.max(0.03, (grab.p - L0) / (1 - L0)));
        const tri = sigma <= gp ? sigma / gp : (1 - sigma) / (1 - gp);
        x += grab.dx * tri * leak;
      }

      if (drawCorner) {
        const h =
          sigma <= cp ? (cornerH * sigma) / cp : (cornerH * (1 - sigma)) / (1 - cp);
        x += h * leak;
        if (raucous) x += (Math.random() - 0.5) * this.vibAmp * 0.5 * leak;
      }

      let m = 0;
      for (let n = 1; n <= N_MODES; n++) {
        m += this.modeAmp[n - 1] * Math.sin(n * Math.PI * sigma) * Math.cos(this.modePhase[n - 1]);
      }
      x += m * leak * modalScale;

      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = this.yTop - s * this.yLen;
      this.positions[i * 3 + 2] = z;
    }

    this.line.geometry.setPositions(Array.from(this.positions));
    this.glow.geometry.setPositions(Array.from(this.positions));
    this.glowMat.opacity = Math.min(0.55, this.vibAmp * 4.4 + (grab ? 0.12 : 0));
    // colour shifts warmer when the tone is raucous/crunchy
    this.glowMat.color.setHSL(raucous ? 0.04 : 0.58, 0.85, 0.62);
  }
}

/** Lowest standing mode (2..N_MODES) with an *interior* node at p, or 0 if none. */
function lowestNodeMode(p: number): number {
  for (let n = 2; n <= N_MODES; n++) {
    // nearest node index of mode n; k=0 (nut) and k=n (bridge) are the trivial
    // endpoints, not flageolet nodes — without this guard sin(nπp)→0 as p→0|1
    // gives a false low-harmonic hit when the finger is near either end.
    const k = Math.round(n * p);
    if (k <= 0 || k >= n) continue;
    if (Math.abs(Math.sin(n * Math.PI * p)) < 0.2) return n;
  }
  return 0;
}
