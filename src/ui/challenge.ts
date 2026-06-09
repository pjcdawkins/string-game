/**
 * Challenge ("game") mode: hit and hold target notes on the current string.
 * Scoring uses the honest pitch detector on the actual audio output, so a
 * wobbly bow stroke or a mis-placed finger costs points exactly as it would
 * cost intonation in real life.
 */
import { state, STRINGS, freqToNote } from "../state";

const HOLD_NEEDED = 1.2; // seconds in tune
const TOLERANCE_CENTS = 25;

interface Target {
  label: string;
  freq: number;
  semis: number;
}

export class Challenge {
  active = false;
  private target: Target | null = null;
  private hold = 0;
  private centsAcc = 0;
  private centsN = 0;
  private score = 0;
  private streak = 0;
  private flashTimer = 0;

  private el: HTMLElement;
  private labelEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private subEl!: HTMLElement;
  private centsEl!: HTMLElement;
  private progEl!: HTMLElement;
  private scoreEl!: HTMLElement;

  constructor(parent: HTMLElement, private button: HTMLButtonElement) {
    this.el = document.createElement("div");
    this.el.id = "challenge";
    this.el.className = "panel challenge hidden";
    this.el.innerHTML = `
      <div class="ch-label">target</div>
      <div class="ch-note"></div>
      <div class="ch-sub"></div>
      <div class="ch-cents"></div>
      <div class="ch-progress"><div></div></div>
      <div class="ch-score"></div>
      <button class="seg" id="chSkip">Skip</button>`;
    parent.appendChild(this.el);
    this.labelEl = this.el.querySelector(".ch-label") as HTMLElement;
    this.noteEl = this.el.querySelector(".ch-note") as HTMLElement;
    this.subEl = this.el.querySelector(".ch-sub") as HTMLElement;
    this.centsEl = this.el.querySelector(".ch-cents") as HTMLElement;
    this.progEl = this.el.querySelector(".ch-progress div") as HTMLElement;
    this.scoreEl = this.el.querySelector(".ch-score") as HTMLElement;
    (this.el.querySelector("#chSkip") as HTMLButtonElement).addEventListener("click", () =>
      this.next()
    );
    button.addEventListener("click", () => (this.active ? this.stop() : this.start()));
  }

  start(): void {
    this.active = true;
    this.score = 0;
    this.streak = 0;
    this.button.textContent = "■ Stop";
    this.el.classList.remove("hidden");
    this.next();
  }

  stop(): void {
    this.active = false;
    this.button.textContent = "▶ Challenge";
    this.el.classList.add("hidden");
  }

  private next(): void {
    const f0 = STRINGS[state.stringIdx].spec.f0;
    const semis = Math.floor(Math.random() * 13); // open .. octave
    const freq = f0 * Math.pow(2, semis / 12);
    const n = freqToNote(freq);
    this.target = { label: n ? n.name : "?", freq, semis };
    this.hold = 0;
    this.centsAcc = 0;
    this.centsN = 0;
    this.flashTimer = 0;
    this.labelEl.textContent = "target";
    this.noteEl.textContent = this.target.label;
    this.noteEl.className = "ch-note";
    const hint =
      semis === 0 ? "open string" : `${semis} semitone${semis > 1 ? "s" : ""} up`;
    this.subEl.textContent = `${freq.toFixed(1)} Hz · ${hint}`;
  }

  update(dt: number): void {
    if (!this.active || !this.target) return;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.next();
      return;
    }
    const det = state.detectedFreq;
    let cents: number | null = null;
    if (det > 0 && state.meter.rms > 0.002) {
      cents = 1200 * Math.log2(det / this.target.freq);
    }
    if (cents !== null && Math.abs(cents) <= TOLERANCE_CENTS) {
      this.hold += dt;
      this.centsAcc += Math.abs(cents);
      this.centsN++;
      if (this.hold >= HOLD_NEEDED) {
        const avg = this.centsN ? this.centsAcc / this.centsN : TOLERANCE_CENTS;
        this.streak++;
        const pts = Math.round(Math.max(20, 120 - avg * 3) + this.streak * 10);
        this.score += pts;
        this.flashTimer = 1.0;
        this.labelEl.textContent = "nailed it";
        this.noteEl.textContent = `✓ +${pts}`;
        this.noteEl.className = "ch-note hit";
        this.subEl.textContent = `streak ×${this.streak}`;
        this.centsEl.textContent = "";
        this.progEl.style.width = "100%";
        this.scoreEl.textContent = `Score ${this.score}`;
        return;
      }
    } else {
      this.hold = Math.max(0, this.hold - dt * 1.5);
    }
    const inTune = cents !== null && Math.abs(cents) <= TOLERANCE_CENTS;
    this.noteEl.className = inTune ? "ch-note ok" : "ch-note";
    this.centsEl.textContent =
      cents === null ? "play it…" : `${cents >= 0 ? "+" : ""}${cents.toFixed(0)}¢`;
    this.progEl.style.width = `${Math.min(100, (this.hold / HOLD_NEEDED) * 100)}%`;
    this.scoreEl.textContent = `Score ${this.score} · streak ×${this.streak}`;
  }
}
