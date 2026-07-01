/**
 * Desktop keyboard play, hands sitting like on the instrument. The left hand
 * lives on the number row: 1–5 stop the string in whole-tone steps above the
 * open string, Shift lowers the held finger a semitone (2n−1 semitones), and
 * 0 forces the open string. Number keys behave like real fingers — the note
 * sounds while the key is held, and releasing falls back to the next held
 * finger (so trills just work) or lifts the hand. The right hand lives on the
 * arrows: → is a down bow, ← an up bow, ↑/↓ slide the contact point toward
 * the nut/bridge, and [ / ] ease off / lean into the string (bow pressure).
 */
import { engine } from "../audio/engine";
import { state, notify, FINGER_RADIUS } from "../state";
import type { Interactions } from "./interactions";

/** Semitones above the open string for each finger key (before Shift). */
const FINGER_KEYS: Record<string, number> = {
  Digit1: 2,
  Digit2: 4,
  Digit3: 6,
  Digit4: 8,
  Digit5: 10,
};

const BOW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

// matches the HUD pressure slider's range
const FORCE_MIN = 0.05;
const FORCE_MAX = 1.2;
const FORCE_STEP = 0.05;

export class Keyboard {
  /** Finger keys currently held, in press order — the newest one wins. */
  private heldFingers: string[] = [];
  private heldArrows = new Set<string>();
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
      // re-pitch a held finger live, so Shift doubles as a semitone slide
      if (!this.shiftHeld) {
        this.shiftHeld = true;
        this.applyFinger();
      }
      return;
    }
    if (e.code in FINGER_KEYS) {
      e.preventDefault();
      if (e.repeat) return;
      void engine.ensureStarted();
      this.shiftHeld = e.shiftKey;
      this.heldFingers = this.heldFingers.filter((c) => c !== e.code);
      this.heldFingers.push(e.code);
      this.applyFinger();
      return;
    }
    if (e.code === "Digit0") {
      e.preventDefault();
      this.heldFingers = [];
      this.input.liftFinger();
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
      this.heldArrows.add(e.code);
      this.syncArrows();
      return;
    }
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      e.preventDefault();
      const step = e.code === "BracketRight" ? FORCE_STEP : -FORCE_STEP;
      state.bowForce = Math.min(FORCE_MAX, Math.max(FORCE_MIN, state.bowForce + step));
      notify();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === "Shift") {
      if (this.shiftHeld) {
        this.shiftHeld = false;
        this.applyFinger();
      }
      return;
    }
    if (e.code in FINGER_KEYS) {
      this.heldFingers = this.heldFingers.filter((c) => c !== e.code);
      if (this.heldFingers.length) this.applyFinger();
      else this.input.liftFinger();
      return;
    }
    if (BOW_KEYS.has(e.code)) {
      this.heldArrows.delete(e.code);
      this.syncArrows();
    }
  }

  private releaseAll(): void {
    if (this.heldFingers.length) this.input.liftFinger();
    this.heldFingers = [];
    this.heldArrows.clear();
    this.shiftHeld = false;
    this.syncArrows();
  }

  /** Latch the newest held finger onto its equal-tempered position. */
  private applyFinger(): void {
    const code = this.heldFingers[this.heldFingers.length - 1];
    if (!code) return;
    const semis = FINGER_KEYS[code] - (this.shiftHeld ? 1 : 0);
    // aim the fingertip's bridge-side edge (the acoustic stop) at the node
    const stop = 1 - Math.pow(2, -semis / 12);
    this.input.placeFingerAt(stop - FINGER_RADIUS);
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
}

function sign(v: number): -1 | 0 | 1 {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]") !== null;
}
