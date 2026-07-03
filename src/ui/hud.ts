/** DOM heads-up display: tool/string pickers, technique controls, tuner. */
import { state, notify, subscribe, STRINGS, freqToNote, fingerStop, Tool, LeftMode } from "../state";
import { engine } from "../audio/engine";

/** localStorage flag: the intro help has been dismissed once already. */
const HELP_SEEN_KEY = "stringGame.helpSeen";

export class Hud {
  private root: HTMLElement;
  private noteEl!: HTMLElement;
  private centsEl!: HTMLElement;
  private centsNeedle!: HTMLElement;
  private freqEl!: HTMLElement;
  private slipEl!: HTMLElement;
  private posNoteEl!: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "hud";
    this.root.innerHTML = this.template();
    parent.appendChild(this.root);
    this.bind();
    subscribe(() => this.sync());
    this.sync();
  }

  private template(): string {
    const stringBtns = STRINGS.map(
      (s, i) =>
        `<button class="seg str" data-str="${i}" title="${s.numeral} string">${s.name[0]}<sub>${s.name.slice(1)}</sub></button>`
    ).join("");
    return `
    <div class="panel top-left">
      <div class="title">Bowed String <span class="sub">physical model</span></div>
      <div class="row seg-group" id="tools">
        <button class="seg tool" data-tool="bow">🎻 Bow</button>
        <button class="seg tool" data-tool="pick">▷ Pick</button>
        <button class="seg tool" data-tool="finger">☝ Pizz</button>
      </div>
      <div class="row seg-group" id="leftmode">
        <span class="lbl">Left hand</span>
        <button class="seg lm" data-lm="press">Press</button>
        <button class="seg lm" data-lm="touch">Touch<span class="hide-narrow">&nbsp;(harm.)</span></button>
        <button class="seg" id="lift">Lift ⌫</button>
      </div>
    </div>
    <div class="panel top-right">
      <div class="row seg-group">${stringBtns}</div>
      <div class="row pos-note" id="posnote">&nbsp;</div>
    </div>
    <div class="panel tuner">
      <div class="note" id="note">—</div>
      <div class="cents-bar"><div class="needle" id="needle"></div></div>
      <div class="tuner-row"><span id="cents">±0¢</span><span id="freq"></span><span id="slip" class="slip"></span></div>
    </div>
    <div class="panel bottom-left">
      <label>Bow pressure <input type="range" id="force" min="0.05" max="1.2" step="0.01"></label>
      <button id="helpBtn" class="seg">?</button>
    </div>
    <div class="overlay hidden" id="help">
      <div class="card" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="card-head">
          <h2 id="helpTitle">How to play</h2>
          <button class="seg close-x" id="closeHelpX" aria-label="Close help">✕</button>
        </div>
        <div class="card-body">
        <p><b>Right hand</b>: with the <b>Bow</b>, press and drag sideways — stroke speed
        is bow speed, vertical position chooses the contact point, from over the
        fingerboard (<i>sul&nbsp;tasto</i>: round, flutey) down to the bridge
        (<i>sul&nbsp;ponticello</i>: glassy, rich in harmonics). The bow pressure slider
        (or pen/touch pressure) sets bow weight: too little skates on the surface, too
        much chokes and crunches. With <b>Pick</b>/<b>Pizz</b>, grab the string anywhere
        you could bow — even over the fingerboard — bend it sideways and release.</p>
        <p><b>Left hand</b> (on the fingerboard): click to place a finger — it stays
        (latches) so you can bow with the mouse. Drag for glissando. Quick-tap the
        finger (or press <kbd>Esc</kbd> / <b>Lift</b>) to lift it. In <b>Touch</b> mode the
        finger only brushes the string: touch a glowing node to sound a natural
        harmonic.</p>
        <p><b>Multi-touch</b>: hold a stop with one finger while bowing with another.</p>
        <p class="desktop-only"><b>Keyboard</b> (desktop): right hand — <kbd>→</kbd> down bow, <kbd>←</kbd> up bow
        (flip direction when you run out of bow), hold <kbd>Space</kbd> for auto-bowing,
        <kbd>↑</kbd>/<kbd>↓</kbd> slide the contact point toward the nut/bridge, hold
        <kbd>[</kbd>/<kbd>]</kbd> to ease off / lean into the string. Left hand — digits are
        semitones above the open string (<kbd>1</kbd> = semitone … <kbd>9</kbd>) and held
        digits <i>add</i>: 4+3 stops a fifth, 9+3 an octave. Releasing peels intervals off, and
        letting go of every digit leaves the finger latched there — <kbd>0</kbd> plays the open
        string and <kbd>Esc</kbd> lifts the hand. Hold <kbd>Shift</kbd> for portamento slides.
        <kbd>S</kbd> is the firm press (stop).
        Everything combines mid-stroke: slide the contact point, swell, and change fingers
        while bowing.</p>
        <p class="desktop-only"><b>Strings</b> (desktop): <kbd>Page&nbsp;Up</kbd>/<kbd>Page&nbsp;Down</kbd>
        move up/down one string, or press its letter — <kbd>G</kbd> <kbd>D</kbd> <kbd>A</kbd> <kbd>E</kbd> —
        to jump straight there. <kbd>,</kbd>/<kbd>.</kbd> slow down / speed up the bow (arrow strokes
        and auto-bow alike, even mid-stroke), and <kbd>?</kbd> reopens this help.</p>
        <p>Try: slide the bow toward the bridge (ponticello glassiness) or over the
        fingerboard (tasto flute); crank bow pressure at low speed for the raucous
        regime; touch ½, ⅓, ¼ nodes for harmonics.</p>
        </div>
        <div class="card-foot">
          <button class="seg accent" id="closeHelp">Close</button>
        </div>
      </div>
    </div>`;
  }

  private bind(): void {
    const $ = <T extends HTMLElement>(sel: string): T => this.root.querySelector(sel) as T;
    this.noteEl = $("#note");
    this.centsEl = $("#cents");
    this.centsNeedle = $("#needle");
    this.freqEl = $("#freq");
    this.slipEl = $("#slip");
    this.posNoteEl = $("#posnote");

    this.root.querySelectorAll<HTMLButtonElement>(".tool").forEach((b) =>
      tap(b, () => {
        state.tool = b.dataset.tool as Tool;
        notify();
      })
    );
    this.root.querySelectorAll<HTMLButtonElement>(".lm").forEach((b) =>
      tap(b, () => {
        state.leftMode = b.dataset.lm as LeftMode;
        notify();
      })
    );
    this.root.querySelectorAll<HTMLButtonElement>(".str").forEach((b) =>
      tap(b, () => {
        state.stringIdx = Number(b.dataset.str);
        void engine.ensureStarted().then(() => engine.setString(STRINGS[state.stringIdx].spec));
        notify();
      })
    );
    tap($("#lift"), () => {
      state.fingerOn = false;
      notify();
    });

    const force = $<HTMLInputElement>("#force");
    force.addEventListener("input", () => (state.bowForce = Number(force.value)));

    const help = $("#help");
    const closeHelp = () => {
      help.classList.add("hidden");
      // any dismissal counts as having seen the intro
      try {
        localStorage.setItem(HELP_SEEN_KEY, "1");
      } catch {
        /* storage unavailable (private mode etc.) — just don't persist */
      }
    };
    tap($("#helpBtn"), () => help.classList.remove("hidden"));
    tap($("#closeHelp"), closeHelp);
    tap($("#closeHelpX"), closeHelp);
    // tapping the dimmed backdrop (not the card) also dismisses
    help.addEventListener("pointerdown", (e) => {
      if (e.target === help) closeHelp();
    });
    const helpOpen = () => !help.classList.contains("hidden");
    // Esc or Enter dismiss the dialog; capture phase so the gameplay Esc
    // handler (lift finger) doesn't also fire while the dialog is up, and so
    // Enter doesn't leak into any focused control
    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.key === "Escape" || e.key === "Enter") && helpOpen()) {
          closeHelp();
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    // ? opens the help dialog (mirrors the ? button)
    window.addEventListener("keydown", (e) => {
      if (e.key === "?" && !helpOpen()) help.classList.remove("hidden");
    });
    // auto-open help on the first visit only; the ? button reopens it
    let seen = false;
    try {
      seen = localStorage.getItem(HELP_SEEN_KEY) === "1";
    } catch {
      /* storage unavailable — treat as first visit */
    }
    if (!seen) help.classList.remove("hidden");
  }

  /** Position (0..1 from the nut) the cursor is hovering over, or null. */
  private hoverS: number | null = null;

  setHoverPosition(s: number | null): void {
    this.hoverS = s;
  }

  /** Reflect state into the controls. */
  private sync(): void {
    this.root.querySelectorAll<HTMLButtonElement>(".tool").forEach((b) =>
      b.classList.toggle("on", b.dataset.tool === state.tool)
    );
    this.root.querySelectorAll<HTMLButtonElement>(".lm").forEach((b) =>
      b.classList.toggle("on", b.dataset.lm === state.leftMode)
    );
    this.root.querySelectorAll<HTMLButtonElement>(".str").forEach((b) =>
      b.classList.toggle("on", Number(b.dataset.str) === state.stringIdx)
    );
    (this.root.querySelector("#force") as HTMLInputElement).value = String(state.bowForce);
  }

  /** Per-frame tuner + position readout update. */
  updateMeters(): void {
    const f = state.detectedFreq;
    if (f > 0 && state.meter.rms > 0.001) {
      const n = freqToNote(f);
      if (n) {
        this.noteEl.textContent = n.name;
        this.centsEl.textContent = `${n.cents >= 0 ? "+" : ""}${n.cents}¢`;
        this.freqEl.textContent = `${f.toFixed(1)} Hz`;
        this.centsNeedle.style.left = `${50 + Math.max(-50, Math.min(50, n.cents))}%`;
        this.centsNeedle.style.opacity = "1";
      }
    } else {
      this.noteEl.textContent = "—";
      this.centsEl.textContent = "";
      this.freqEl.textContent = "";
      this.centsNeedle.style.opacity = "0.2";
    }
    const m = state.meter;
    if (m.bowing && m.rms > 0.002) {
      // prolonged sticking = overpressure ("pressed"/raucous); mostly
      // slipping = the bow skating over the string ("surface" whistle)
      const txt = m.slipRatio < 0.04 ? "pressed" : m.slipRatio > 0.6 ? "surface" : "stick–slip";
      this.slipEl.textContent = txt;
      this.slipEl.className =
        "slip " + (m.slipRatio < 0.04 ? "bad" : m.slipRatio > 0.6 ? "warn" : "good");
    } else {
      this.slipEl.textContent = "";
    }
    // note under the finger, or a guide for the hovered position
    const f0 = STRINGS[state.stringIdx].spec.f0;
    if (state.fingerOn) {
      const n = freqToNote(f0 / (1 - fingerStop(state.fingerPos)));
      if (n) this.posNoteEl.textContent = `stop: ${n.name} ${n.cents >= 0 ? "+" : ""}${n.cents}¢`;
    } else if (this.hoverS !== null && this.hoverS > 0.01) {
      const n = freqToNote(f0 / (1 - fingerStop(this.hoverS)));
      if (n) this.posNoteEl.textContent = `here: ${n.name} ${n.cents >= 0 ? "+" : ""}${n.cents}¢`;
    } else {
      this.posNoteEl.innerHTML = "&nbsp;";
    }
  }
}

/**
 * Activate a HUD button on `pointerdown` rather than `click`. Browsers only
 * synthesise `click` for the *primary* pointer, so while one finger holds a
 * bow stroke on the canvas, a second finger tapping a button would otherwise
 * do nothing until the first is lifted — you couldn't switch strings
 * mid-stroke. Reacting on press (not release) also makes switching feel
 * immediate, and it keeps engine.ensureStarted() inside the live user
 * gesture, which iOS requires to unlock audio. Keyboard activation still
 * arrives as a `click` with detail 0 and no preceding pointerdown.
 */
function tap(el: HTMLElement, fn: () => void): void {
  el.addEventListener("pointerdown", (e) => {
    // Only the main button: right/middle clicks must not activate. Every
    // touch contact reports button 0, so this keeps non-primary fingers
    // working — an isPrimary check here would re-break mid-stroke taps.
    if (e.button !== 0) return;
    e.preventDefault(); // keep focus where it is; no compat mouse events
    fn();
  });
  el.addEventListener("click", (e) => {
    if (e.detail === 0) fn(); // keyboard (Enter/Space) only
  });
}
