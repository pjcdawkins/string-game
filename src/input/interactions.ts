/**
 * Pointer interaction layer. The viewport is split at the end of the
 * fingerboard: gestures on the fingerboard control the left hand (stopping /
 * harmonic touches, with glissando and tap-to-lift), gestures below it apply
 * the selected implement (bow strokes, plectrum/finger plucks).
 * Multi-touch works: one finger can hold a stop while another bows.
 */
import { SceneView } from "../scene/scene";
import { engine } from "../audio/engine";
import { state, notify, FINGERBOARD_END, FINGER_RADIUS, fingerStop } from "../state";
import type { GrabState } from "../scene/visualString";

/** Bow and plucks alike may reach well over the fingerboard (sul tasto). */
export const BOW_MIN = 0.48;
export const BOW_MAX = 0.985;
// fingerPos is the fingertip CENTRE; letting it slide a radius up onto the nut
// puts the note's terminating edge on the nut, i.e. the open string
const FINGER_MIN = -FINGER_RADIUS;
const FINGER_MAX = 0.82;
const MAX_BEND = 0.55;

// Keyboard bowing (arrow keys, see input/keyboard.ts): model bow speed while
// a stroke key is held, how far the bow may travel laterally before it runs
// out of hair, how fast model velocity sweeps that travel, and how fast the
// up/down arrows slide the contact point along the string.
const KEY_BOW_SPEED = 0.32;
const KEY_BOW_END = 1.2;
const KEY_BOW_XRATE = 4.0;
const KEY_CONTACT_RATE = 0.35;

export class Interactions {
  // public state read by the render loop
  grabbed: GrabState | null = null;
  bowEngaged = false;
  bowPos = 0.88;
  bowVel = 0; // smoothed, model units
  bowX = 0; // lateral position of the bow mesh
  hover: { s: number; x: number } | null = null;
  fingerPressure = 0; // ramped actual pressure
  // keyboard bowing intents (written by input/keyboard.ts, consumed in update)
  keyBowDir: -1 | 0 | 1 = 0;
  keyContactDir: -1 | 0 | 1 = 0;

  private leftPointer = -1;
  private rightPointer = -1;
  private leftMoved = false;
  private leftDownTime = 0;
  private leftDownPos = 0;
  private pressureTarget = 0;
  private lastFrameX = 0; // bow x at the previous frame (for gesture velocity)
  private pointerForce = -1; // pen/touch pressure if meaningful
  private autoBowDir = 1;
  private autoBowTimer = 0;
  // every stroke starts with a little extra bow weight (the "bite") which
  // reliably pulls the string into the fundamental Helmholtz regime instead
  // of the double-slip octave
  private biteTimer = 999;
  private wasAutoBow = false;
  private prevKeyBowDir = 0;
  private wasKeyBowing = false;

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

  /** True while the arrow keys are driving a bow stroke (a held pointer
   * stroke always wins over the keyboard). */
  get keyBowing(): boolean {
    return this.keyBowDir !== 0 && !this.bowEngaged;
  }

  /** Where the left-hand zone ends and the implement zone begins. The bow
   * and the plucking implements may all reach over the fingerboard (sul
   * tasto); only while auto-bow holds the stroke does the whole fingerboard
   * belong to the left hand. */
  zoneBoundary(): number {
    return state.autoBow ? FINGERBOARD_END : BOW_MIN;
  }

  /** Lowest position the bow/pluck may take: always on the bridge side of a
   * stopped finger — the nut-side portion of the string is not modelled. */
  implementMin(): number {
    return state.fingerOn ? Math.max(BOW_MIN, state.fingerPos + 0.06) : BOW_MIN;
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
        this.bowPos = clamp(c.s, this.implementMin(), BOW_MAX);
        this.bowX = c.x;
        this.lastFrameX = c.x;
        this.bowVel = 0;
        this.biteTimer = 0;
      } else if (Math.abs(c.x) < 0.4) {
        this.grabbed = {
          p: clamp(c.s, this.implementMin(), BOW_MAX),
          dx: clamp(c.x, -MAX_BEND, MAX_BEND),
        };
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
        this.bowX = c.x;
        this.bowPos = clamp(c.s, this.implementMin(), BOW_MAX);
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
          // vibration starts at the fingertip's bridge-side edge (the node)
          const stopped = state.fingerOn && this.fingerPressure > 0.55 ? fingerStop(state.fingerPos) : 0;
          this.view.visual.pluckVisual(g.p, g.dx, stopped);
        }
      }
    }
  }

  private tappedExistingFinger = false;

  private placeFinger(s: number): void {
    const p = clamp(s, FINGER_MIN, FINGER_MAX);
    if (state.fingerOn && Math.abs(p - state.fingerPos) < 0.035) {
      this.tappedExistingFinger = true;
    }
    this.placeFingerAt(p);
  }

  /** Latch or move the finger directly (used by the keyboard shortcuts). */
  placeFingerAt(s: number): void {
    state.fingerOn = true;
    state.fingerPos = clamp(s, FINGER_MIN, FINGER_MAX);
    this.pressureTarget = state.leftMode === "press" ? 1 : 0.13;
    notify();
  }

  private moveFinger(s: number): void {
    this.tappedExistingFinger = false;
    state.fingerPos = clamp(s, FINGER_MIN, FINGER_MAX);
    notify();
  }

  liftFinger(): void {
    state.fingerOn = false;
    this.pressureTarget = 0;
    notify();
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

    // a finger sliding up under a held bow/stroke pushes it toward the bridge
    this.bowPos = clamp(this.bowPos, this.implementMin(), BOW_MAX);

    // up/down arrows slide the bow's contact point toward the nut/bridge
    if (this.keyContactDir !== 0 && !this.bowEngaged) {
      this.bowPos = clamp(
        this.bowPos + this.keyContactDir * KEY_CONTACT_RATE * dt,
        this.implementMin(),
        BOW_MAX
      );
    }

    const force = this.pointerForce > 0 ? state.bowForce * (0.3 + 1.5 * this.pointerForce) : state.bowForce;

    this.biteTimer += dt;
    const bite = 1 + 0.4 * Math.max(0, 1 - this.biteTimer / 0.25);

    if (this.bowEngaged) {
      // bow speed follows the gesture: the per-frame derivative of the
      // pointer's lateral position, lightly smoothed (it naturally falls to
      // zero when the pointer stops moving)
      const v = (this.bowX - this.lastFrameX) / Math.max(1e-3, dt);
      this.lastFrameX = this.bowX;
      const target = clamp(v * 0.06, -0.75, 0.75);
      this.bowVel += (target - this.bowVel) * Math.min(1, dt * 12);
      engine.setBow(true, this.bowVel, force * bite, this.bowPos);
    } else if (this.keyBowing) {
      if (this.keyBowDir !== this.prevKeyBowDir) {
        // a fresh stroke or a bow change gets the starting "bite"
        this.biteTimer = 0;
        // with under half the travel left in the new direction, retake the
        // bow (lift and reset to the far end) — so a repeated down bow / up
        // bow speaks instead of starting where the last stroke ran out
        const remaining =
          this.keyBowDir > 0 ? KEY_BOW_END - this.bowX : this.bowX + KEY_BOW_END;
        if (remaining < KEY_BOW_END * 0.5) this.bowX = -this.keyBowDir * KEY_BOW_END;
      }
      // the stroke dies away when it runs out of bow at either end; flipping
      // direction (a bow change) is the way to keep the sound going
      const atEnd = this.keyBowDir > 0 ? this.bowX >= KEY_BOW_END : this.bowX <= -KEY_BOW_END;
      const target = atEnd ? 0 : this.keyBowDir * KEY_BOW_SPEED;
      this.bowVel += (target - this.bowVel) * Math.min(1, dt * 10);
      this.bowX = clamp(this.bowX + this.bowVel * KEY_BOW_XRATE * dt, -KEY_BOW_END, KEY_BOW_END);
      this.lastFrameX = this.bowX;
      engine.setBow(true, this.bowVel, force * bite, this.bowPos);
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
    // releasing the last stroke key or switching auto-bow off ends the stroke
    const bowingNow = this.bowEngaged || this.keyBowing || state.autoBow;
    if (!bowingNow && (this.wasKeyBowing || this.wasAutoBow)) engine.setBowOn(false);
    this.wasKeyBowing = this.keyBowing;
    this.prevKeyBowDir = this.keyBowing ? this.keyBowDir : 0;
    this.wasAutoBow = state.autoBow;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
