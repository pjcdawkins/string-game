/**
 * Desktop keyboard play, hands sitting like on the instrument. The left hand
 * lives on the number row: each held digit contributes its value in semitones
 * above the open string (1 = semitone, 2 = whole tone … 9), and chords of
 * digits ADD — 4+3 stops a fifth, 9+3 an octave — so intervals beyond nine
 * semitones are quick to build. Chords peel as fingers lift, but the finger
 * latches: releasing every digit leaves it stopped at the last position (0 or
 * Esc lift it), and a chord released all at once latches at the full chord. Holding Shift makes pitch changes portamento — the finger
 * glides instead of jumping. The right hand lives on the arrows: → is a down
 * bow, ← an up bow, ↑/↓ slide the contact point toward the nut/bridge, and
 * holding [ / ] eases off / leans into the string (bow pressure). Holding
 * Space sustains an automatic détaché instead (release to stop); the arrows
 * stay fully manual, and override it while held. In the pick/pizz tools the
 * right hand plucks instead: → and ← each pluck (as does Space), ↑/↓ still
 * place where the pluck lands, and [ / ] set how hard. All of it combines
 * mid-stroke. The string is chosen with Page Up/Page Down (one string at a
 * time, no looping) or by its letter name (G/D/A/E); , and . nudge the bow
 * speed down/up (manual and auto alike, even mid-stroke); S sets the firm
 * Press stop and H the light Touch (harmonics). P toggles pizzicato and \
 * toggles the pick, each dropping back to the bow when pressed a second time.
 * Esc lifts the left hand and returns the right to an ordinary arco.
 */
import { engine } from "../audio/engine";
import { state, notify, STRINGS, FINGER_RADIUS } from "../state";
import type { Interactions } from "./interactions";

/** Semitones above the open string contributed by each held finger key. */
const FINGER_KEYS: Record<string, number> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
  Digit7: 7,
  Digit8: 8,
  Digit9: 9,
};

const BOW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Letter keys that jump straight to a named open string (G/D/A/E on a
 * violin). Derived from the string set's note names, so adding a viola/cello
 * (with a C string) extends this automatically. */
const STRING_BY_LETTER: Record<string, number> = {};
STRINGS.forEach((s, i) => {
  STRING_BY_LETTER[s.name[0].toUpperCase()] = i;
});

/** Releasing a chord of digits "together" really means several keyup events a
 * few milliseconds apart. Wait this long before treating a lone keyup as
 * "peel this interval off", so a chord released together latches at the full
 * chord's position instead of snapping to whichever digit's release happened
 * to straggle in last. */
const CHORD_RELEASE_GRACE_MS = 80;

// , / . nudge the auto-bow speed down / up over the model's range.
const BOW_SPEED_STEP = 0.03;
const BOW_SPEED_MIN = 0.02;
const BOW_SPEED_MAX = 0.6;

export class Keyboard {
  /** Finger keys currently held; their semitone values add up. */
  private heldFingers = new Set<string>();
  /** Pending "peel the released digit off the chord" from a finger keyup;
   * cancelled if the rest of the chord releases within the grace period. */
  private peelTimer: ReturnType<typeof setTimeout> | null = null;
  private heldArrows = new Set<string>();
  private heldBrackets = new Set<string>();
  private shiftHeld = false;

  constructor(private input: Interactions) {
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    // key releases can't be observed while the window is unfocused
    window.addEventListener("blur", () => this.releaseAll());
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (isEditable(e.target)) return;
    if (e.key === "Shift") {
      this.shiftHeld = true; // portamento: pitch changes glide while held
      return;
    }
    if (e.code in FINGER_KEYS) {
      e.preventDefault();
      if (e.repeat) return;
      void engine.ensureStarted();
      this.shiftHeld = e.shiftKey;
      this.cancelPeel();
      this.heldFingers.add(e.code);
      this.applyFinger();
      return;
    }
    if (e.code === "Digit0") {
      e.preventDefault();
      this.cancelPeel();
      this.heldFingers.clear();
      this.input.liftFinger();
      return;
    }
    // Esc resets to the default hand: Interactions' own Esc listener lifts the
    // left hand (open string); here the right hand returns to an ordinary bow.
    // A pending peel must not survive the lift and re-latch the finger.
    if (e.code === "Escape") {
      this.cancelPeel();
      state.tool = "bow";
      state.leftMode = "press";
      notify();
      return;
    }
    // \ toggles the pick; pressing it again drops back to the bow (arco).
    // Match the produced character, not e.code "Backslash": the physical
    // backslash sits on different keys across layouts (e.g. IntlBackslash on
    // UK/ISO boards), but they all type "\".
    if (e.key === "\\" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.repeat) return;
      state.tool = state.tool === "pick" ? "bow" : "pick";
      notify();
      return;
    }
    // string switching: Page Up/Down step one string (no looping past the ends)
    if (e.code === "PageUp" || e.code === "PageDown") {
      e.preventDefault();
      if (e.repeat) return;
      this.selectString(state.stringIdx + (e.code === "PageUp" ? 1 : -1));
      return;
    }
    // letter keys jump to a named open string (G/D/A/E)
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const letter = e.key.toUpperCase();
      if (letter in STRING_BY_LETTER) {
        e.preventDefault();
        if (e.repeat) return;
        this.selectString(STRING_BY_LETTER[letter]);
        return;
      }
      // S = "stop" with the left hand: the firm Press mode (as in the HUD)
      if (letter === "S") {
        e.preventDefault();
        if (e.repeat) return;
        state.leftMode = "press";
        notify();
        return;
      }
      // H = the light Touch mode for natural harmonics (as in the HUD)
      if (letter === "H") {
        e.preventDefault();
        if (e.repeat) return;
        state.leftMode = "touch";
        notify();
        return;
      }
      // P toggles pizzicato (the finger tool); a second press returns to arco.
      if (letter === "P") {
        e.preventDefault();
        if (e.repeat) return;
        state.tool = state.tool === "finger" ? "bow" : "finger";
        notify();
        return;
      }
    }
    // , / . decrease / increase the (auto-)bow speed; repeat to sweep
    if (e.code === "Comma" || e.code === "Period") {
      e.preventDefault();
      const dir = e.code === "Period" ? 1 : -1;
      state.autoBowSpeed = clamp(
        state.autoBowSpeed + dir * BOW_SPEED_STEP,
        BOW_SPEED_MIN,
        BOW_SPEED_MAX
      );
      notify();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      // in a pluck tool Space plucks the active string instead of auto-bowing
      if (state.tool !== "bow") {
        this.input.keyPluck();
        return;
      }
      void engine.ensureStarted();
      state.autoBow = true;
      notify();
      return;
    }
    if (BOW_KEYS.has(e.code)) {
      e.preventDefault();
      if (e.repeat) return;
      void engine.ensureStarted();
      // in a pluck tool, ← / → each pluck the string (up-/down-stroke) rather
      // than bowing; ↑ / ↓ still slide the contact point where the pluck lands
      if (state.tool !== "bow" && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        this.input.keyPluck(e.code === "ArrowRight" ? 1 : -1);
        return;
      }
      // bowing from the keyboard implies the bow tool
      if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && state.tool !== "bow") {
        state.tool = "bow";
        notify();
      }
      // the resting ghost bow follows the keys now, not the last mouse hover
      this.input.hover = null;
      this.heldArrows.add(e.code);
      this.syncArrows();
      return;
    }
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      e.preventDefault();
      if (e.repeat) return;
      this.heldBrackets.add(e.code);
      this.syncBrackets();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === "Shift") {
      this.shiftHeld = false;
      return;
    }
    if (e.code in FINGER_KEYS) {
      this.heldFingers.delete(e.code);
      // While other digits are still down the interval peels off; releasing
      // the last one leaves the finger latched where it is (like a mouse
      // click). 0 or Esc lift it. The peel waits out a short grace period:
      // if the remaining digits release within it, the whole chord was let
      // go together and the finger stays latched at the chord's position.
      this.cancelPeel();
      if (this.heldFingers.size) {
        this.peelTimer = setTimeout(() => {
          this.peelTimer = null;
          this.applyFinger();
        }, CHORD_RELEASE_GRACE_MS);
      }
      return;
    }
    if (e.code === "Space") {
      state.autoBow = false;
      notify();
      return;
    }
    if (BOW_KEYS.has(e.code)) {
      this.heldArrows.delete(e.code);
      this.syncArrows();
      return;
    }
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      this.heldBrackets.delete(e.code);
      this.syncBrackets();
    }
  }

  private releaseAll(): void {
    this.cancelPeel();
    if (this.heldFingers.size) this.input.liftFinger();
    this.heldFingers.clear();
    this.heldArrows.clear();
    this.heldBrackets.clear();
    this.shiftHeld = false;
    state.autoBow = false;
    this.syncArrows();
    this.syncBrackets();
  }

  private cancelPeel(): void {
    if (this.peelTimer !== null) {
      clearTimeout(this.peelTimer);
      this.peelTimer = null;
    }
  }

  /** Latch the finger onto the equal-tempered position for the sum of all
   * held digits' semitones (gliding there if Shift asks for portamento). */
  private applyFinger(): void {
    if (this.heldFingers.size === 0) return;
    let semis = 0;
    for (const code of this.heldFingers) semis += FINGER_KEYS[code];
    // A press speaks from the fingertip's bridge-side edge, so aim the centre
    // a radius short of the node; a Touch-mode brush damps under the centre,
    // so aim it dead on (9+3 then touches the octave's ½-node flageolet).
    const stop = 1 - Math.pow(2, -semis / 12);
    this.input.placeFingerAt(
      state.leftMode === "touch" ? stop : stop - FINGER_RADIUS,
      this.shiftHeld
    );
  }

  private syncArrows(): void {
    const a = this.heldArrows;
    this.input.keyBowDir = sign(
      (a.has("ArrowRight") ? 1 : 0) - (a.has("ArrowLeft") ? 1 : 0)
    );
    this.input.keyContactDir = sign(
      (a.has("ArrowDown") ? 1 : 0) - (a.has("ArrowUp") ? 1 : 0)
    );
  }

  private syncBrackets(): void {
    const b = this.heldBrackets;
    this.input.keyForceDir = sign(
      (b.has("BracketRight") ? 1 : 0) - (b.has("BracketLeft") ? 1 : 0)
    );
  }

  /** Switch to string `idx`, clamped to the ends (no wrap-around), starting
   * audio and pushing the new string's spec into the engine like the HUD's
   * string buttons do. */
  private selectString(idx: number): void {
    const next = Math.max(0, Math.min(STRINGS.length - 1, idx));
    if (next === state.stringIdx) return;
    state.stringIdx = next;
    void engine.ensureStarted().then(() => engine.selectString(next));
    notify();
  }
}

function sign(v: number): -1 | 0 | 1 {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]") !== null;
}
