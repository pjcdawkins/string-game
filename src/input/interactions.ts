/**
 * Pointer interaction layer. The viewport is split at the end of the
 * fingerboard: gestures on the fingerboard control the left hand (stopping /
 * harmonic touches, with glissando and tap-to-lift), gestures below it apply
 * the selected implement (bow strokes, plectrum/finger plucks).
 * Multi-touch works: one finger can hold a stop while another bows.
 */
import { SceneView } from "../scene/scene";
import { engine } from "../audio/engine";
import { state, notify, FINGERBOARD_END, semitonePos } from "../state";
import type { GrabState } from "../scene/visualString";

/** The bow may reach well over the fingerboard for extreme sul tasto. */
export const BOW_MIN = 0.48;
const BOW_MAX = 0.97;
const FINGER_MIN = 0.02;
const FINGER_MAX = 0.6;
const MAX_BEND = 0.55;

export class Interactions {
  // public state read by the render loop
  grabbed: GrabState | null = null;
  bowEngaged = false;
  bowPos = 0.88;
  bowVel = 0; // smoothed, model units
  bowX = 0; // lateral position of the bow mesh
  hover: { s: number; x: number } | null = null;
  fingerPressure = 0; // ramped actual pressure

  private leftPointer = -1;
  private rightPointer = -1;
  private leftMoved = false;
  private leftDownTime = 0;
  private leftDownPos = 0;
  private pressureTarget = 0;
  private lastBowSample: { x: number; t: number } | null = null;
  private pointerForce = -1; // pen/touch pressure if meaningful
  private autoBowDir = 1;
  private autoBowTimer = 0;
  // every stroke starts with a little extra bow weight (the "bite") which
  // reliably pulls the string into the fundamental Helmholtz regime instead
  // of the double-slip octave
  private biteTimer = 999;
  private wasAutoBow = false;

  constructor(private view: SceneView, canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.liftFinger();
    });
  }

  /** Where the left-hand zone ends and the implement zone begins. When
   * manually bowing, the bow zone extends over the fingerboard (sul tasto);
   * otherwise the whole fingerboard belongs to the left hand. */
  zoneBoundary(): number {
    return state.tool === "bow" && !state.autoBow ? BOW_MIN : FINGERBOARD_END;
  }

  private onDown(e: PointerEvent): void {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    void engine.ensureStarted();
    const c = this.view.screenToString(e.clientX, e.clientY);
    if (c.s < this.zoneBoundary() && Math.abs(c.x) < 1.2) {
      if (this.leftPointer !== -1) return;
      this.leftPointer = e.pointerId;
      this.leftMoved = false;
      this.leftDownTime = performance.now();
      this.leftDownPos = c.s;
      this.placeFinger(c.s);
    } else {
      if (this.rightPointer !== -1) return;
      this.rightPointer = e.pointerId;
      this.pointerForce = e.pointerType !== "mouse" && e.pressure > 0 ? e.pressure : -1;
      if (state.tool === "bow") {
        this.bowEngaged = true;
        this.bowPos = clamp(c.s, BOW_MIN, BOW_MAX);
        this.bowX = c.x;
        this.lastBowSample = { x: c.x, t: performance.now() };
        this.bowVel = 0;
        this.biteTimer = 0;
      } else if (Math.abs(c.x) < 0.4) {
        this.grabbed = { p: clamp(c.s, BOW_MIN, BOW_MAX), dx: clamp(c.x, -MAX_BEND, MAX_BEND) };
      }
    }
  }

  private onMove(e: PointerEvent): void {
    const c = this.view.screenToString(e.clientX, e.clientY);
    if (e.pointerId === this.leftPointer) {
      if (Math.abs(c.s - this.leftDownPos) > 0.012) this.leftMoved = true;
      if (this.leftMoved) this.moveFinger(c.s);
      return;
    }
    if (e.pointerId === this.rightPointer) {
      this.pointerForce = e.pointerType !== "mouse" && e.pressure > 0 ? e.pressure : -1;
      if (this.bowEngaged) {
        const now = performance.now();
        if (this.lastBowSample) {
          const dt = Math.max(1, now - this.lastBowSample.t) / 1000;
          const v = (c.x - this.lastBowSample.x) / dt;
          // smooth toward instantaneous velocity
          this.bowVel += (v * 0.045 - this.bowVel) * Math.min(1, dt * 18);
        }
        this.lastBowSample = { x: c.x, t: now };
        this.bowX = c.x;
        this.bowPos = clamp(c.s, BOW_MIN, BOW_MAX);
      } else if (this.grabbed) {
        this.grabbed.dx = clamp(c.x, -MAX_BEND, MAX_BEND);
      }
      return;
    }
    this.hover = c;
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.leftPointer) {
      this.leftPointer = -1;
      const quickTap = performance.now() - this.leftDownTime < 220 && !this.leftMoved;
      // a quick tap on an already-latched finger lifts it; otherwise it stays
      if (quickTap && this.tappedExistingFinger) this.liftFinger();
      this.tappedExistingFinger = false;
      return;
    }
    if (e.pointerId === this.rightPointer) {
      this.rightPointer = -1;
      this.pointerForce = -1;
      if (this.bowEngaged) {
        this.bowEngaged = false;
        if (!state.autoBow) engine.setBowOn(false);
      }
      if (this.grabbed) {
        const g = this.grabbed;
        this.grabbed = null;
        const force = Math.min(1.4, (Math.abs(g.dx) / MAX_BEND) * 1.2);
        if (force > 0.02) {
          const widthMs = state.tool === "pick" ? 0.7 : 5.0;
          engine.pluck(g.p, force, widthMs);
          const stopped = state.fingerOn && this.fingerPressure > 0.55 ? state.fingerPos : 0;
          const harmonic =
            state.fingerOn && this.fingerPressure > 0.02 && this.fingerPressure <= 0.55
              ? state.fingerPos
              : 0;
          this.view.visual.pluckVisual(g.p, g.dx, stopped, harmonic);
        }
      }
    }
  }

  private tappedExistingFinger = false;

  private placeFinger(s: number): void {
    const p = this.snap(clamp(s, FINGER_MIN, FINGER_MAX));
    if (state.fingerOn && Math.abs(p - state.fingerPos) < 0.035) {
      this.tappedExistingFinger = true;
    }
    state.fingerOn = true;
    state.fingerPos = p;
    this.pressureTarget = state.leftMode === "press" ? 1 : 0.13;
    notify();
  }

  private moveFinger(s: number): void {
    this.tappedExistingFinger = false;
    state.fingerPos = this.snap(clamp(s, FINGER_MIN, FINGER_MAX));
    notify();
  }

  liftFinger(): void {
    state.fingerOn = false;
    this.pressureTarget = 0;
    notify();
  }

  private snap(p: number): number {
    if (!state.snap) return p;
    let best = p;
    let bestD = 0.018;
    for (let m = 0; m <= 14; m++) {
      const sp = semitonePos(m);
      const d = Math.abs(sp - p);
      if (d < bestD) {
        bestD = d;
        best = sp;
      }
    }
    return best;
  }

  /** Per-frame: ramps, auto-bow, and pushing state into the audio engine. */
  update(dt: number): void {
    // finger pressure ramp (fast but not instant — like a real finger landing)
    const rate = this.pressureTarget > this.fingerPressure ? 14 : 22;
    this.fingerPressure +=
      (this.pressureTarget * (state.fingerOn ? 1 : 0) - this.fingerPressure) *
      Math.min(1, dt * rate);
    if (state.fingerOn && state.leftMode === "press") this.pressureTarget = 1;
    else if (state.fingerOn) this.pressureTarget = 0.13;
    state.fingerPressure = this.fingerPressure;
    engine.setFinger(state.fingerOn, state.fingerPos, this.fingerPressure);

    const force = this.pointerForce > 0 ? state.bowForce * (0.3 + 1.5 * this.pointerForce) : state.bowForce;

    this.biteTimer += dt;
    const bite = 1 + 0.4 * Math.max(0, 1 - this.biteTimer / 0.25);

    if (this.bowEngaged) {
      // velocity decays if the pointer stops moving
      this.bowVel *= Math.exp(-dt * 6);
      engine.setBow(true, clamp(this.bowVel, -0.75, 0.75), force * bite, this.bowPos);
    } else if (state.autoBow) {
      if (!this.wasAutoBow) this.biteTimer = 0;
      this.autoBowTimer += dt;
      const STROKE = 2.6;
      if (this.autoBowTimer > STROKE) {
        this.autoBowTimer = 0;
        this.autoBowDir = -this.autoBowDir;
        this.biteTimer = 0;
      }
      // at a bow change the velocity passes through zero (like a real
      // détaché) — keeping the force up while speed ramps avoids kicking
      // the string into the double-slip (octave) regime
      const edge = Math.min(this.autoBowTimer, STROKE - this.autoBowTimer);
      const ramp = Math.min(1, edge / 0.09);
      this.bowVel = this.autoBowDir * state.autoBowSpeed * ramp;
      this.bowX = Math.sin((this.autoBowTimer / STROKE - 0.5) * Math.PI) * -this.autoBowDir * 1.2;
      engine.setBow(true, this.bowVel, state.bowForce * bite, this.bowPos);
    }
    this.wasAutoBow = state.autoBow;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
