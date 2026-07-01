/**
 * Desktop keyboard play, hands sitting like on the instrument. The left hand
 * lives on the number row: each held digit contributes its value in semitones
 * above the open string (1 = semitone, 2 = whole tone … 9), and chords of
 * digits ADD — 4+3 stops a fifth, 9+3 an octave — so intervals beyond nine
 * semitones are quick to build. 0 forces the open string. Digits behave like
 * real fingers: the note sounds while held, releasing peels its interval off
 * again (or lifts the hand entirely), and holding Shift makes pitch changes
 * portamento — the finger glides instead of jumping. The right hand lives on
 * the arrows: → is a down bow, ← an up bow, ↑/↓ slide the contact point
 * toward the nut/bridge, and holding [ / ] eases off / leans into the string
 * (bow pressure). Holding Space sustains an automatic détaché instead
 * (release to stop); the arrows stay fully manual, and override it while
 * held. All of it combines mid-stroke.
 */
import { engine } from "../audio/engine";
import { state, notify, FINGER_RADIUS } from "../state";
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

export class Keyboard {
  /** Finger keys currently held; their semitone values add up. */
  private heldFingers = new Set<string>();
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
      this.heldFingers.add(e.code);
      this.applyFinger();
      return;
    }
    if (e.code === "Digit0") {
      e.preventDefault();
      this.heldFingers.clear();
      this.input.liftFinger();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      void engine.ensureStarted();
      if (state.tool !== "bow") state.tool = "bow";
      state.autoBow = true;
      notify();
      return;
    }
    if (BOW_KEYS.has(e.code)) {
      e.preventDefault();
      if (e.repeat) return;
      void engine.ensureStarted();
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
      if (this.heldFingers.size) this.applyFinger();
      else this.input.liftFinger();
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
    if (this.heldFingers.size) this.input.liftFinger();
    this.heldFingers.clear();
    this.heldArrows.clear();
    this.heldBrackets.clear();
    this.shiftHeld = false;
    state.autoBow = false;
    this.syncArrows();
    this.syncBrackets();
  }

  /** Latch the finger onto the equal-tempered position for the sum of all
   * held digits' semitones (gliding there if Shift asks for portamento). */
  private applyFinger(): void {
    if (this.heldFingers.size === 0) return;
    let semis = 0;
    for (const code of this.heldFingers) semis += FINGER_KEYS[code];
    // aim the fingertip's bridge-side edge (the acoustic stop) at the node
    const stop = 1 - Math.pow(2, -semis / 12);
    this.input.placeFingerAt(stop - FINGER_RADIUS, this.shiftHeld);
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
}

function sign(v: number): -1 | 0 | 1 {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]") !== null;
}
