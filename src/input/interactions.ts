/**
 * Pointer interaction layer. The viewport is split at the end of the
 * fingerboard: gestures on the fingerboard control the left hand (stopping /
 * harmonic touches, with glissando and tap-to-lift), gestures below it apply
 * the selected implement (bow strokes, plectrum/finger plucks).
 * Multi-touch works: one finger can hold a stop while another bows.
 */
import { SceneView } from "../scene/scene";
import { BOW_HAIR_SPAN } from "../scene/tools";
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

// How far the bow may travel laterally (in bowX units) before it runs out of
// hair — shared by keyboard strokes and pointer strokes alike.
export const BOW_END = 1.2;

// Pointer bowing responds like a mouse with pointer acceleration: a slow,
// deliberate drag maps ~1:1 in *world space* (the contact point tracks under
// the pointer, so dragging the width of the bow bows the width of the bow),
// while faster gestures are progressively amplified, saturating toward
// ACCEL_MAX×. The gain feeds both the visual bow travel and the audio model's
// bow velocity. Because the bow's on-screen size varies with the viewport
// (see scene.applyBowScale), a full stroke is a big, deliberate gesture on a
// wide desktop bow and a quick screen-wide flick on a narrow phone — the world
// mapping keeps the *feel* honest on both, reconciling the two. With the
// current constants a leisurely drag lands a medium stroke (~5 s end to end),
// a brisk drag a fast one (~1.5 s), a flick the extreme-fast floor (~0.5 s),
// and a slow creep the extreme-slow ceiling (up toward a minute).
const ACCEL_MAX = 2.2; // gesture gain at very fast speeds
const ACCEL_REF = 4.0; // gesture speed (world units/s) giving half the extra gain

// Keyboard bowing (arrow keys, see input/keyboard.ts): model bow speed while a
// stroke key is held, and how fast that sweeps the bow's normalised travel. The
// travel rate is tuned for a ~3.5 s full-length stroke — a singing medium
// détaché that sits in the same speed band as an unhurried pointer stroke, so
// the keyboard and the mouse feel like the same bow. (The duration is fixed;
// the *visible* speed scales with the bow's on-screen size, faster on a wide
// desktop bow, so a held arrow no longer crawls across a stubby bow.) Also how
// fast the up/down arrows slide the contact point along the string.
// KEY_BOW_SPEED is the manual stroke speed at the *default* bow-speed setting;
// arrow strokes scale with the shared setting (state.autoBowSpeed, nudged by
// , / .) about that default, so one control governs both the manual and the
// auto bow and it responds live even mid-stroke. BOW_SPEED_DEFAULT mirrors the
// state's initial autoBowSpeed.
const KEY_BOW_SPEED = 0.32;
const BOW_SPEED_DEFAULT = 0.22;
const KEY_BOW_XRATE = 2.1;
const KEY_CONTACT_RATE = 0.35;
// Attack of a keyboard stroke: speed rises from rest over KEY_ATTACK_S while
// an extra-heavy bite (KEY_BITE_AMP, vs 0.4 for pointer/auto-bow) holds the
// force up. This pairing captures the Helmholtz fundamental ~99% of the time
// across cold, ringing and finger-landing attacks; the measurements and the
// alternatives (including the model upgrades that would allow real-violin
// attack speeds) are written up in MODEL_NOTES.md.
const KEY_ATTACK_S = 0.15;
const KEY_BITE_AMP = 0.8;

// [ / ] ramp the bow pressure while held, over the HUD slider's range.
const KEY_FORCE_RATE = 0.35;
const FORCE_MIN = 0.05;
const FORCE_MAX = 1.2;

// Portamento (Shift + a finger key): exponential approach rate of the finger
// toward its target position — fast at first, easing in, like a real slide.
const FINGER_GLIDE_RATE = 8;

export class Interactions {
  // public state read by the render loop
  grabbed: GrabState | null = null;
  bowEngaged = false;
  bowPos = 0.88;
  bowVel = 0; // smoothed, model units
  bowX = 0; // lateral bow travel in [-BOW_END, BOW_END], drives the bow mesh
  hover: { s: number; x: number } | null = null;
  fingerPressure = 0; // ramped actual pressure
  // keyboard bowing intents (written by input/keyboard.ts, consumed in update)
  keyBowDir: -1 | 0 | 1 = 0;
  keyContactDir: -1 | 0 | 1 = 0;
  keyForceDir: -1 | 0 | 1 = 0;

  private leftPointer = -1;
  private rightPointer = -1;
  private leftMoved = false;
  private leftDownTime = 0;
  private leftDownPos = 0;
  private pressureTarget = 0;
  private pointerRawX = 0; // raw pointer lateral position (pre-acceleration)
  private gestureDx = 0; // raw pointer movement accumulated since last frame
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
  private keyStrokeTime = 0; // seconds since the current keyboard stroke began
  private fingerGlideTarget: number | null = null;

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

  /** World units the bow's contact point travels per unit of bowX, at the
   * bow's current on-screen size. A full stroke (bowX over ±BOW_END) sweeps the
   * whole playable hair, so this is the hair length / the bowX range. Used to
   * map pointer motion to bow travel 1:1 in world space. */
  private bowWorldGain(): number {
    return (BOW_HAIR_SPAN / (2 * BOW_END)) * this.view.bowMeshScale;
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
        this.bowX = clamp(c.x, -BOW_END, BOW_END);
        this.pointerRawX = c.x;
        this.gestureDx = 0;
        this.bowVel = 0;
        this.biteTimer = 0;
      } else {
        // grab displacement is measured from the string's own lane (the
        // selected string sits off-centre — see scene/lanes.ts)
        const p = clamp(c.s, this.implementMin(), BOW_MAX);
        const dx = c.x - this.view.activeLaneX(p);
        if (Math.abs(dx) < 0.4) {
          this.grabbed = { p, dx: clamp(dx, -MAX_BEND, MAX_BEND) };
        }
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
        this.gestureDx += c.x - this.pointerRawX;
        this.pointerRawX = c.x;
        this.bowPos = clamp(c.s, this.implementMin(), BOW_MAX);
      } else if (this.grabbed) {
        this.grabbed.dx = clamp(
          c.x - this.view.activeLaneX(this.grabbed.p),
          -MAX_BEND,
          MAX_BEND
        );
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

  /** Latch or move the finger directly (used by the keyboard shortcuts).
   * With `glide`, a finger already down slides to the new position
   * (portamento) instead of jumping. */
  placeFingerAt(s: number, glide = false): void {
    const p = clamp(s, FINGER_MIN, FINGER_MAX);
    if (glide && state.fingerOn) {
      this.fingerGlideTarget = p;
    } else {
      state.fingerPos = p;
      this.fingerGlideTarget = null;
      this.rearticulate();
    }
    state.fingerOn = true;
    this.pressureTarget = state.leftMode === "press" ? 1 : 0.13;
    notify();
  }

  private moveFinger(s: number): void {
    this.tappedExistingFinger = false;
    state.fingerPos = clamp(s, FINGER_MIN, FINGER_MAX);
    this.fingerGlideTarget = null; // a pointer drag takes over from any glide
    notify();
  }

  liftFinger(): void {
    state.fingerOn = false;
    this.pressureTarget = 0;
    this.fingerGlideTarget = null;
    this.rearticulate();
    notify();
  }

  /** A finger landing or lifting under a live stroke re-triggers the bow
   * "bite" (as a player re-articulates with a touch of extra weight), so the
   * new string length recaptures Helmholtz instead of choking to a whisper. */
  private rearticulate(): void {
    if (this.bowEngaged || this.keyBowing || state.autoBow) this.biteTimer = 0;
  }

  /** Per-frame: ramps, auto-bow, and pushing state into the audio engine. */
  update(dt: number): void {
    // portamento: the finger slides toward its target position
    if (this.fingerGlideTarget !== null && state.fingerOn) {
      const d = this.fingerGlideTarget - state.fingerPos;
      if (Math.abs(d) < 0.002) {
        state.fingerPos = this.fingerGlideTarget;
        this.fingerGlideTarget = null;
      } else {
        state.fingerPos += d * Math.min(1, dt * FINGER_GLIDE_RATE);
      }
    }

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

    // [ / ] lean into / ease off the string, live even mid-stroke
    if (this.keyForceDir !== 0) {
      state.bowForce = clamp(
        state.bowForce + this.keyForceDir * KEY_FORCE_RATE * dt,
        FORCE_MIN,
        FORCE_MAX
      );
      notify();
    }

    const force = this.pointerForce > 0 ? state.bowForce * (0.3 + 1.5 * this.pointerForce) : state.bowForce;

    this.biteTimer += dt;
    const bite = 1 + 0.4 * Math.max(0, 1 - this.biteTimer / 0.25);

    if (this.bowEngaged) {
      // bow speed follows the gesture: the pointer's lateral movement this
      // frame, put through the acceleration gain (see ACCEL_MAX above). The
      // amplified movement drives the bow mesh via bowX, mapped 1:1 in world
      // space (÷ the bow's world size) so the contact tracks under the pointer
      // regardless of how large the bow is drawn; and the same amplified speed
      // sets the audio model's (lightly smoothed) bow velocity.
      const dxWorld = this.gestureDx;
      this.gestureDx = 0;
      const raw = dxWorld / Math.max(1e-3, dt);
      const gain = 1 + (ACCEL_MAX - 1) * (Math.abs(raw) / (Math.abs(raw) + ACCEL_REF));
      this.bowX = clamp(this.bowX + (dxWorld * gain) / this.bowWorldGain(), -BOW_END, BOW_END);
      const target = clamp(raw * gain * 0.06, -0.75, 0.75);
      this.bowVel += (target - this.bowVel) * Math.min(1, dt * 12);
      engine.setBow(true, this.bowVel, force * bite, this.bowPos);
    } else if (this.keyBowing) {
      if (this.keyBowDir !== this.prevKeyBowDir) {
        // a fresh stroke or a bow change gets the starting "bite"
        this.biteTimer = 0;
        this.keyStrokeTime = 0;
        // with under half the travel left in the new direction, retake the
        // bow (lift and reset to the far end) — so a repeated down bow / up
        // bow speaks instead of starting where the last stroke ran out
        const remaining =
          this.keyBowDir > 0 ? BOW_END - this.bowX : this.bowX + BOW_END;
        if (remaining < BOW_END * 0.5) this.bowX = -this.keyBowDir * BOW_END;
      }
      this.keyStrokeTime += dt;
      // the stroke dies away when it runs out of bow at either end; flipping
      // direction (a bow change) is the way to keep the sound going
      const atEnd = this.keyBowDir > 0 ? this.bowX >= BOW_END : this.bowX <= -BOW_END;
      if (atEnd) {
        this.bowVel += (0 - this.bowVel) * Math.min(1, dt * 10);
      } else {
        // linear attack: force held up (the bite) while speed rises gently
        // from zero reliably captures the Helmholtz fundamental instead of
        // a higher slip regime
        const ramp = Math.min(1, this.keyStrokeTime / KEY_ATTACK_S);
        // scale the tuned default speed by the shared bow-speed setting, so
        // , / . slow down / speed up the arrow-key strokes too, live
        const speed = KEY_BOW_SPEED * (state.autoBowSpeed / BOW_SPEED_DEFAULT);
        this.bowVel = this.keyBowDir * speed * ramp;
      }
      this.bowX = clamp(this.bowX + this.bowVel * KEY_BOW_XRATE * dt, -BOW_END, BOW_END);
      const kbite = 1 + KEY_BITE_AMP * Math.max(0, 1 - this.biteTimer / 0.25);
      engine.setBow(true, this.bowVel, force * kbite, this.bowPos);
    } else if (state.autoBow) {
      if (!this.wasAutoBow) this.biteTimer = 0;
      this.autoBowTimer += dt;
      // the détaché's stroke length tracks its speed setting, so a faster
      // auto-bow visibly sweeps faster (and a slow one lingers), landing in the
      // same fast→slow band as the manual strokes rather than a fixed tempo.
      const STROKE = clamp(0.57 / Math.max(0.02, state.autoBowSpeed), 0.6, 40);
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
      this.bowX = Math.sin((this.autoBowTimer / STROKE - 0.5) * Math.PI) * -this.autoBowDir * BOW_END;
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
