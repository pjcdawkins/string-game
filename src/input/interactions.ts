/**
 * Pointer interaction layer. The fingerboard, directly over and just beside the
 * strings, belongs to the left hand: a tap there stops whichever string lane
 * the touch is nearest — touching a different string moves the finger (and the
 * bow, which always plays the finger's string) over to it — a drag glissandos,
 * and the drag may carry the finger past the board's end toward the bridge.
 * Everything else is the right hand — below the board, or reaching in from the
 * flanks to either side, where a lone touch can bow or pizz sul tasto without a
 * stop. Tapping a latched finger re-places it (just like tapping the empty
 * string there, so it may shift slightly onto the snap target); it lifts when
 * flicked sideways off its string, and a tap above the nut or in the top-left
 * corner of the play area lifts the hand too. Multi-touch works: one finger holds a stop
 * while another bows, and a second touch on the board clearly to the bridge
 * side of a held stop is the right hand playing over the board (sul tasto /
 * pizz).
 */
import { SceneView, STRING_LEN, BRIDGE_RISE } from "../scene/scene";
import { BOW_HAIR_SPAN } from "../scene/tools";
import { laneX, N_LANES } from "../scene/lanes";
import { engine } from "../audio/engine";
import { state, notify, FINGERBOARD_END, FINGER_RADIUS, fingerStop, STRINGS } from "../state";
import { snapFinger } from "./snap";
import type { GrabState } from "../scene/visualString";

/** Bow and plucks alike may reach well over the fingerboard (sul tasto). */
export const BOW_MIN = 0.48;
// The bridge is drawn lifted by BRIDGE_RISE (its base at the f-hole lower-eye
// line), so its crown — where the string breaks and the hair should stop — is
// at sToY(1) + BRIDGE_RISE, i.e. the string coordinate 1 - BRIDGE_RISE/STRING_LEN.
// Stop the bow just there so the hair meets the top of the bridge rather than
// running down toward STRING_BOT (which is below the lifted bridge).
export const BOW_MAX = 1 - BRIDGE_RISE / STRING_LEN;
// Minimum gap kept between a stopped finger and the bow contact: the bow always
// sits on the bridge side of the finger, with at least this much string between
// them (see implementMin) — roughly the width the bow itself needs.
const BOW_CLEARANCE = 0.06;
// fingerPos is the fingertip CENTRE; letting it slide a radius up onto the nut
// puts the note's terminating edge on the nut, i.e. the open string
const FINGER_MIN = -FINGER_RADIUS;
// A tap only ever lands on the fingerboard (s < FINGERBOARD_END), but a drag
// may carry the finger on past the board's end toward the bridge — as far up as
// a bow can still fit between it and the bridge, i.e. one bow-clearance short of
// the bow's own bridge-side limit (about a bow-width from the bridge).
const FINGER_DRAG_MAX = BOW_MAX - BOW_CLEARANCE;
// Furthest the string can be pulled aside for a pluck (world units), and the
// displacement at which the pluck reaches full force. Kept within a few lane
// widths (the lanes sit 0.062..0.128 apart, see scene/lanes.ts) so the bend
// and the ring-down that starts from it read as one string among four — the
// same reasoning as the bowed swing's VIB_AMP_MAX in scene/visualString.ts.
// Everything downstream scales with it consistently: the grab clamps here,
// the release seeds the visual ring-down at the held displacement, and the
// audio force maps off the same range.
const MAX_BEND = 0.18;
// A fingertip pizz's soft force pulse, as a fraction of the string period —
// wide enough to sound mellow (rounder than the plectrum) but not so wide it
// self-cancels into a whisper. Period-relative so it balances across the range.
const FINGER_PLUCK_PERIOD_FRAC = 1.5;

// Lateral half-width (world units) of the left-hand catch on the fingerboard: a
// touch within this of the strings' centre line stops the string, while one
// further out to either side is the right hand reaching in (bow contact / pizz)
// — so an open string can be bowed or plucked sul tasto from just beside the
// board, no stop needed. The strings span ~±0.19 and the board ~±0.24, so this
// stays comfortably wider than the board while leaving the flanks to the bow.
export const LEFT_CATCH_X = 0.45;
// A left-hand touch catches the string lane laterally nearest to it, with the
// current string winning near-ties (within this world-unit margin) so a touch
// dead between two lanes doesn't hop strings.
const LANE_STICKY = 0.02;
// A latched finger no longer lifts on a tap (the tap just leaves it latched —
// friendlier under touch, where taps land imprecisely). Instead it lifts when
// flicked sideways off its string: at least this far laterally (world units),
// and clearly more lateral than along the string.
const LIFT_SWIPE_X = 0.12;
// The same touch turns into a glissando drag instead once it travels this far
// (world units) predominantly *along* the string — the world-unit twin of the
// 0.012-of-string-length threshold used for an ordinary placing drag.
const DRAG_ALONG = 0.045;
// Tapping the top-left corner of the play area — nut-ward of this fraction of
// the string, out beyond the board's left flank — lifts the hand (all
// fingers): a big, easy "clear" target for touch play, well away from every
// other tap target (main.ts keeps the tool ghosts out of it too). The right
// flank stays a bow/pizz reach-in zone at every height.
export const LIFT_ZONE_S = 0.3;
// While a finger already holds a stop, a second touch over the strings counts
// as the right hand (sul tasto / pizz over the board) only this far or more
// toward the bridge from the stop; nearer than that it is ambiguous and ignored
// so it can't be taken for a second stop. Comfortably more than BOW_CLEARANCE.
const SECOND_TOUCH_GAP = 0.12;

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

// How long the implement's flick lingers after a keyboard pluck (seconds).
const KEY_PLUCK_ANIM_S = 0.13;

// Pluck strength scales with the shared Pressure control (state.bowForce),
// normalised about PRESSURE_DEFAULT so that setting reproduces the original
// bend-only feel. KEY_PLUCK_BEND is the nominal pull a keyboard pluck stands
// in for (a mouse pluck measures the real bend); MAX_BEND maps to 1.
const PRESSURE_DEFAULT = 0.45; // mirrors state's initial bowForce
const KEY_PLUCK_BEND = 0.8;

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
  // a keyboard pluck has no held gesture to show the implement, so it leaves a
  // brief flick (read by main.ts): `life` runs 1 -> 0 as the implement retracts
  // from its bent offset `dx` at contact point `p` back to rest.
  pluckAnim: { p: number; dx: number; life: number } | null = null;
  // keyboard bowing intents (written by input/keyboard.ts, consumed in update)
  keyBowDir: -1 | 0 | 1 = 0;
  keyContactDir: -1 | 0 | 1 = 0;
  keyForceDir: -1 | 0 | 1 = 0;

  private leftPointer = -1;
  private rightPointer = -1;
  private leftMoved = false;
  private leftDownPos = 0;
  private leftDownX = 0;
  // the left touch landed on the already-latched finger: it waits — a
  // sideways flick lifts, a drag along the string glissandos, a tap leaves it
  private leftOnFinger = false;
  private pressureTarget = 0;
  private pointerRawX = 0; // raw pointer lateral position (pre-acceleration)
  private gestureDx = 0; // raw pointer movement accumulated since last frame
  private pointerForce = -1; // pen/touch pressure if meaningful
  private autoBowDir = 1;
  private autoBowPhase = 0; // fraction of the way through the current stroke
  // whether the auto-bow actually drove the bow last frame (false while a
  // pointer stroke or held arrow overrides it, even though state.autoBow is
  // still on) — resuming resyncs the stroke phase to the bow's real position
  private autoBowActive = false;
  private keyPluckDir: -1 | 1 = 1; // alternates the snap of successive key plucks
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

  /** Where the left-hand zone ends and the implement zone begins: the end of
   * the fingerboard. The whole board belongs to the left hand — a tap anywhere
   * on it stops the string — while the bow and plucking implements live on the
   * bridge side of the board. They can still be *swept* up onto it (sul tasto)
   * once a stroke is under way; they just can't be started there. */
  zoneBoundary(): number {
    return FINGERBOARD_END;
  }

  /** Lowest position the bow/pluck may take: always on the bridge side of a
   * stopped finger — the nut-side portion of the string is not modelled. */
  implementMin(): number {
    return state.fingerOn ? Math.max(BOW_MIN, state.fingerPos + BOW_CLEARANCE) : BOW_MIN;
  }

  private onDown(e: PointerEvent): void {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    void engine.ensureStarted();
    const c = this.view.screenToString(e.clientX, e.clientY);

    // A tap in the top-left corner of the play area lifts the hand (all
    // fingers) — like the tap above the nut below, but a far bigger target.
    if (c.s < LIFT_ZONE_S && c.x < -LEFT_CATCH_X) {
      this.liftFinger();
      return;
    }

    const onBoard = c.s < this.zoneBoundary();
    const nearStrings = Math.abs(c.x) < LEFT_CATCH_X;

    // The first touch over (or just beside) the strings on the board is the
    // left hand: it stops the nearest string lane — so touching a different
    // string moves the finger (and with it the bow) onto that string.
    if (onBoard && nearStrings && this.leftPointer === -1) {
      // A tap above the nut (s < 0, off the top of the board) lifts the finger
      // — the "clear the hand" gesture; it doesn't begin a drag. The nut is
      // where every string is open, so the tap also selects the lane it lands
      // on: tapping another string at the nut switches to that string, open.
      // (The lanes sit closest together up here — catchLane's stickiness
      // absorbs a tap dead between two of them.)
      if (c.s < 0) {
        const lane = this.catchLane(c);
        if (lane !== state.stringIdx) this.selectString(lane);
        this.liftFinger();
        return;
      }
      this.leftPointer = e.pointerId;
      this.leftMoved = false;
      this.leftDownPos = c.s;
      this.leftDownX = c.x;
      const lane = this.catchLane(c);
      this.leftOnFinger =
        state.fingerOn && lane === state.stringIdx && Math.abs(c.s - state.fingerPos) < 0.035;
      // A tap on the already-held finger behaves like a tap on the empty string
      // in that region: it re-places (re-articulates) the finger at the tap
      // point, so the finger may shift slightly — onto the snap target. The
      // flick-to-lift and drag-to-glissando gestures below still key off
      // leftOnFinger (a plain tap just leaves the finger latched where it lands).
      if (lane !== state.stringIdx) this.selectString(lane);
      this.placeFingerAt(c.s);
      return;
    }

    // A second touch over the strings, while a stop is already held, is the
    // right hand playing over the board (sul tasto / pizz) — but only clearly
    // on the bridge side of the stop. Nearer than that, or nut-ward of it, is
    // ambiguous (it could be a second stopping finger), so ignore it.
    if (onBoard && nearStrings) {
      if (this.leftPointer !== -1 && c.s > state.fingerPos + SECOND_TOUCH_GAP) {
        this.startImplement(e, c);
      }
      return;
    }

    // Below the board, or reaching in from the flanks to either side: the
    // right hand (a lone touch here bows/pizzes an open string, no stop).
    this.startImplement(e, c);
  }

  /** Begin a right-hand gesture with this pointer: a bow stroke, or a
   * pluck-grab on the active string. */
  private startImplement(e: PointerEvent, c: { s: number; x: number }): void {
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
      // Grab the active string wherever the touch lands and bend it toward the
      // finger (displacement measured from the string's own lane — the selected
      // string sits off-centre, see scene/lanes.ts — and clamped to MAX_BEND).
      // Grabbing no longer needs to start right on the string, so a touch out
      // in the flank pulls the string aside from there: reach in and flick to
      // pizz an open string anywhere up its length.
      const p = clamp(c.s, this.implementMin(), BOW_MAX);
      const dx = clamp(c.x - this.view.activeLaneX(p), -MAX_BEND, MAX_BEND);
      this.grabbed = { p, dx };
    }
  }

  private onMove(e: PointerEvent): void {
    const c = this.view.screenToString(e.clientX, e.clientY);
    if (e.pointerId === this.leftPointer) {
      if (this.leftOnFinger && !this.leftMoved) {
        // undecided touch on the latched finger: a sideways flick lifts it, a
        // pull along the string becomes a glissando drag, anything less waits
        const dx = c.x - this.leftDownX;
        const along = (c.s - this.leftDownPos) * STRING_LEN;
        if (Math.abs(dx) > LIFT_SWIPE_X && Math.abs(dx) > 1.5 * Math.abs(along)) {
          this.leftPointer = -1;
          this.leftOnFinger = false;
          this.liftFinger();
          return;
        }
        if (Math.abs(along) > DRAG_ALONG && Math.abs(along) >= Math.abs(dx)) {
          this.leftMoved = true;
        }
      } else if (Math.abs(c.s - this.leftDownPos) > 0.012) {
        this.leftMoved = true;
      }
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
      // the finger always stays latched — a tap on it no longer lifts it
      // (lifting is the sideways flick in onMove, or the lift tap targets)
      this.leftPointer = -1;
      this.leftOnFinger = false;
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
        const bend = Math.abs(g.dx) / MAX_BEND;
        if (bend > 0.015) this.doPluck(g.p, this.pluckForce(bend), g.dx);
      }
    }
  }

  /** Which string a left-hand touch at `c` catches: the lane laterally
   * nearest to it, with the current string winning near-ties so a touch dead
   * between two lanes doesn't hop strings. Also drives the hover preview
   * (main.ts), so the ghost finger shows which string a touch would land on. */
  catchLane(c: { s: number; x: number }): number {
    const s = clamp(c.s, 0, 1);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < N_LANES; i++) {
      const d = Math.abs(c.x - laneX(i, s));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const current = Math.abs(c.x - laneX(state.stringIdx, s));
    return current - bestD <= LANE_STICKY ? state.stringIdx : best;
  }

  /** Switch the sounding string — the bow always plays the string the finger
   * is on, so it comes along — pushing the new preset into the engine just as
   * the HUD picker and the keyboard letters do. */
  private selectString(idx: number): void {
    state.stringIdx = idx;
    void engine.ensureStarted().then(() => engine.setString(STRINGS[idx].spec));
    notify();
  }

  /** Latch or move the finger directly (used by the keyboard shortcuts).
   * With `glide`, a finger already down slides to the new position
   * (portamento) instead of jumping. */
  placeFingerAt(s: number, glide = false): void {
    const p = clamp(snapFinger(s), FINGER_MIN, FINGER_DRAG_MAX);
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
    // a drag is a glissando: the gentler, smoother snap so the slide sweeps the
    // string rather than dragging note to note (see snapFinger)
    state.fingerPos = clamp(snapFinger(s, true), FINGER_MIN, FINGER_DRAG_MAX);
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

  /** Pluck the active string from the keyboard (Space / arrow keys in the
   * pick or pizz tool). The contact point is the current bow position — moved
   * by the up/down arrows — and the strength follows the bow-pressure keys
   * ([ / ]), the same control that sets bow weight. `dir` bends the string
   * that way for the snap animation; omit it to alternate, so a run of plucks
   * flicks side to side like repeated strokes. */
  keyPluck(dir?: -1 | 1): void {
    void engine.ensureStarted();
    const p = clamp(this.bowPos, this.implementMin(), BOW_MAX);
    if (dir === undefined) dir = this.keyPluckDir = (-this.keyPluckDir as -1 | 1);
    // no real bend to measure, so stand in a nominal pull; Pressure scales it
    const force = this.pluckForce(KEY_PLUCK_BEND);
    const dx = dir * MAX_BEND * Math.min(1, force / 1.2);
    this.doPluck(p, force, dx);
    // show the plectrum/fingertip flicking off the string (mouse plucks show it
    // via `grabbed`; a key pluck is instantaneous, so animate the retract)
    this.pluckAnim = { p, dx, life: 1 };
  }

  /** Pluck force for a string pulled to `bend01` of the maximum, scaled by the
   * shared Pressure control so the slider/[ ] keys drive pluck strength as well
   * as bow weight (default Pressure reproduces the old bend-only force). */
  private pluckForce(bend01: number): number {
    return clamp(bend01 * 1.2 * (state.bowForce / PRESSURE_DEFAULT), 0.02, 1.4);
  }

  /** Excite the active string and seed its ring-down, shared by the pointer and
   * keyboard plucks. `dx` is the bend for the visual snap. */
  private doPluck(p: number, force: number, dx: number): void {
    // a plectrum is a sharp, fixed-width stroke (bright); a fingertip is a soft
    // pulse keyed to the string period, so its mellow tone and level stay
    // consistent from the low strings to the high (see StringSim.pluck)
    if (state.tool === "pick") engine.pluck(p, force, 0.7);
    else engine.pluck(p, force, 0, FINGER_PLUCK_PERIOD_FRAC);
    // vibration starts at the fingertip's bridge-side edge (the node)
    const stopped = state.fingerOn && this.fingerPressure > 0.55 ? fingerStop(state.fingerPos) : 0;
    this.view.visual.pluckVisual(p, dx, stopped);
  }

  /** A finger landing or lifting under a live stroke re-triggers the bow
   * "bite" (as a player re-articulates with a touch of extra weight), so the
   * new string length recaptures Helmholtz instead of choking to a whisper. */
  private rearticulate(): void {
    if (this.bowEngaged || this.keyBowing || state.autoBow) this.biteTimer = 0;
  }

  /** Per-frame: ramps, auto-bow, and pushing state into the audio engine. */
  update(dt: number): void {
    // decay the keyboard-pluck flick (see keyPluck / main.ts)
    if (this.pluckAnim) {
      this.pluckAnim.life -= dt / KEY_PLUCK_ANIM_S;
      if (this.pluckAnim.life <= 0) this.pluckAnim = null;
    }
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
      }
      this.keyStrokeTime += dt;
      // the bow simply meets its limit and stops: the stroke dies away when it
      // runs out of hair at either end, and pressing the same direction again
      // stays put — flipping direction (a bow change) is what recovers travel
      // and keeps the sound going
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
      // the détaché's stroke length tracks its speed setting, so a faster
      // auto-bow visibly sweeps faster (and a slow one lingers), landing in the
      // same fast→slow band as the manual strokes rather than a fixed tempo.
      const STROKE = clamp(0.57 / Math.max(0.02, state.autoBowSpeed), 0.6, 40);
      if (!this.autoBowActive) {
        // taking over (a fresh Space, or resuming after a pointer/arrow
        // override): re-articulate and pick the bow up from wherever it
        // actually rests — stroking toward the far end, with the phase matched
        // to the current bowX so the bow never jumps along its hair
        this.biteTimer = 0;
        this.autoBowDir = this.bowX > 0 ? -1 : 1;
        this.autoBowPhase =
          Math.asin(clamp(this.bowX / (this.autoBowDir * BOW_END), -1, 1)) / Math.PI + 0.5;
      }
      this.autoBowPhase += dt / STROKE;
      if (this.autoBowPhase >= 1) {
        // out of hair: a bow change, back the other way
        this.autoBowPhase = 0;
        this.autoBowDir = -this.autoBowDir;
        this.biteTimer = 0;
      }
      // at a bow change the velocity passes through zero (like a real
      // détaché) — keeping the force up while speed ramps avoids kicking
      // the string into the double-slip (octave) regime
      const edge = Math.min(this.autoBowPhase, 1 - this.autoBowPhase) * STROKE;
      const ramp = Math.min(1, edge / 0.09);
      this.bowVel = this.autoBowDir * state.autoBowSpeed * ramp;
      // sinusoidal travel easing, moving WITH the bow velocity: positive
      // bowVel sweeps frog -> tip, just as it does for pointer/arrow strokes
      // (the sweep used to run the other way, so the drawn bow slid opposite
      // to the string's driven swing)
      this.bowX = Math.sin((this.autoBowPhase - 0.5) * Math.PI) * this.autoBowDir * BOW_END;
      engine.setBow(true, this.bowVel, state.bowForce * bite, this.bowPos);
    }
    // releasing the last stroke key or switching auto-bow off ends the stroke
    const bowingNow = this.bowEngaged || this.keyBowing || state.autoBow;
    if (!bowingNow && (this.wasKeyBowing || this.wasAutoBow)) engine.setBowOn(false);
    this.wasKeyBowing = this.keyBowing;
    this.prevKeyBowDir = this.keyBowing ? this.keyBowDir : 0;
    this.wasAutoBow = state.autoBow;
    this.autoBowActive = !this.bowEngaged && !this.keyBowing && state.autoBow;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
