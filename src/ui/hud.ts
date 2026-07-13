/** DOM heads-up display: tool/string pickers, technique controls, tuner. */
import { state, notify, subscribe, STRINGS, freqToNote, fingerStop, Tool, LeftMode, GuideMode } from "../state";
import { engine } from "../audio/engine";

/** localStorage flag: the intro help has been dismissed once already. */
const HELP_SEEN_KEY = "stringGame.helpSeen";

/** GitHub's mark, inlined as an SVG (no network fetch, themes via currentColor). */
const GITHUB_ICON = `<svg class="gh-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`;

export class Hud {
  private root: HTMLElement;
  private noteEl!: HTMLElement;
  private centsEl!: HTMLElement;
  private centsNeedle!: HTMLElement;
  private freqEl!: HTMLElement;
  private slipEl!: HTMLElement;
  private posNoteEl!: HTMLElement;
  private soundHintEl!: HTMLElement;
  private soundHintText = "";

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
      <div class="row seg-group" id="strings">
        <span class="lbl">String</span>${stringBtns}
      </div>
      <div class="row seg-group" id="leftmode">
        <span class="lbl">Finger</span>
        <button class="seg lm" data-lm="press">Press</button>
        <button class="seg lm" data-lm="touch">Touch<span class="hide-narrow">&nbsp;(harm.)</span></button>
        <button class="seg" id="lift">Lift ⌫</button>
      </div>
    </div>
    <button class="seg menu-btn" id="menuBtn" aria-label="Menu" aria-haspopup="true" aria-expanded="false">☰</button>
    <div class="menu-scrim hidden" id="menuScrim"></div>
    <div class="panel sidebar hidden" id="menu" role="menu" aria-label="Menu">
      <div class="sidebar-head">
        <span class="sidebar-title">Menu</span>
        <button class="seg close-x" id="menuClose" aria-label="Close menu">✕</button>
      </div>
      <button class="seg menu-item" id="menuHelp"><span class="menu-label">How to play…</span></button>
      <button class="seg menu-item toggle" id="menuNodes" role="menuitemcheckbox" aria-checked="false"><span class="menu-label">Node markers</span><span class="checkbox" aria-hidden="true">✓</span></button>
      <div class="seg menu-item select-row" id="menuGuides"><label class="menu-label" for="guideSel">Guides</label><select id="guideSel" class="scale-sel">
        <option value="off">Off</option>
        <option value="chromatic">Chromatic</option>
        <option value="major">Major</option>
        <option value="minor">Minor</option>
      </select></div>
      <button class="seg menu-item toggle" id="menuSnap" role="menuitemcheckbox" aria-checked="false"><span class="menu-label">Snap to guides</span><span class="checkbox" aria-hidden="true">✓</span></button>
      <button class="seg menu-item toggle" id="menuSnapNodes" role="menuitemcheckbox" aria-checked="false"><span class="menu-label">Snap to nodes</span><span class="checkbox" aria-hidden="true">✓</span></button>
      <a class="seg menu-item menu-link" id="menuGithub" href="https://github.com/pjcdawkins/string-game" target="_blank" rel="noopener noreferrer"><span class="menu-label">${GITHUB_ICON}GitHub repo</span><span class="ext" aria-hidden="true">↗</span></a>
    </div>
    <div class="panel tuner">
      <div class="note" id="note">&nbsp;</div>
      <div class="cents-bar"><div class="needle" id="needle"></div></div>
      <div class="tuner-row"><span id="cents" class="cents">±0¢</span><span id="freq" class="freq"></span><span id="slip" class="slip"></span></div>
      <div class="pos-note" id="posnote">&nbsp;</div>
    </div>
    <button class="sound-hint off" id="soundHint" type="button" aria-live="polite"></button>
    <div class="right-station">
      <div class="panel pressure-panel">
        <label>Pressure <input type="range" id="force" min="0.05" max="1.2" step="0.01"></label>
      </div>
      <div class="panel tools-panel">
        <div class="row seg-group" id="tools">
          <button class="seg tool" data-tool="bow">🎻 Bow</button>
          <button class="seg tool" data-tool="finger">☝ Pizz</button>
          <button class="seg tool" data-tool="pick">▷ Pick</button>
        </div>
      </div>
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
        (<i>sul&nbsp;ponticello</i>: glassy, rich in harmonics). The <b>Pressure</b> slider
        (or pen/touch pressure) sets bow weight: too little skates on the surface, too
        much chokes and crunches. With <b>Pick</b>/<b>Pizz</b>, grab the string below the
        fingerboard, or reach in from either side of the board, bend it sideways and
        release — so you can pluck an open string sul tasto, anywhere up its length; how
        far you pull sets the attack, and <b>Pressure</b> scales it too.</p>
        <p><b>Left hand</b>: tap anywhere on the fingerboard to place a finger — it stays
        (latches) so you can bow with the mouse. Tap a different string to move the finger
        there; the bow follows it. Tapping a string at the nut, or its letter in the
        picker, plays it open. Drag for glissando; the drag can even
        carry the finger on past the end of the board, higher than the board itself
        reaches. To lift, flick the finger sideways off its string, tap the top-left
        corner (or above the nut), or press <kbd>Esc</kbd> / <b>Lift</b>. In <b>Touch</b>
        mode the finger only brushes the string: touch a node to sound a natural
        harmonic (<i>Node markers</i> in the ☰ menu shows where they are). The menu's
        <i>Guides</i> rules faint fret-like lines across the fingerboard — a scale rooted
        on the open string: an equal-tempered chromatic, or major or minor in meantone
        tuning — and <i>Snap to guides</i> gently magnetises a pressed finger onto them;
        in Touch mode <i>Snap to nodes</i> magnetises the harmonic nodes instead.</p>
        <p><b>Multi-touch</b>: hold a stop with one finger while bowing or plucking with
        another — a second touch on the board, bridge-side of the stop, plays over the
        board (sul tasto).</p>
        <p class="desktop-only"><b>Keyboard</b> (desktop): right hand — <kbd>→</kbd> down bow, <kbd>←</kbd> up bow
        (flip direction when you run out of bow), hold <kbd>Space</kbd> for auto-bowing,
        <kbd>↑</kbd>/<kbd>↓</kbd> slide the contact point toward the nut/bridge, hold
        <kbd>[</kbd>/<kbd>]</kbd> to ease off / lean into the string. In <b>Pick</b>/<b>Pizz</b>
        the right hand plucks instead: <kbd>→</kbd>/<kbd>←</kbd> (and <kbd>Space</kbd>) each pluck,
        <kbd>↑</kbd>/<kbd>↓</kbd> set where, and <kbd>[</kbd>/<kbd>]</kbd> how hard. Left hand — digits are
        semitones above the open string (<kbd>1</kbd> = semitone … <kbd>9</kbd>) and held
        digits <i>add</i>: 4+3 stops a fifth, 9+3 an octave. Releasing peels intervals off, and
        letting go of every digit leaves the finger latched there — <kbd>0</kbd> plays the open
        string and <kbd>Esc</kbd> lifts the hand (and returns the right hand to an ordinary
        bow). Hold <kbd>Shift</kbd> for portamento slides.
        <kbd>S</kbd> is the firm press (stop), <kbd>H</kbd> the light touch (harmonics).
        <kbd>P</kbd> toggles pizzicato and <kbd>\\</kbd> the pick — press either again to return to
        the bow. Everything combines mid-stroke: slide the contact point, swell, and change
        fingers while bowing.</p>
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
    this.soundHintEl = $("#soundHint");
    // The pill is a real button so tapping it unlocks audio *without* the tap
    // falling through to the canvas and stopping the string high up (which is
    // a poor place to start). ensureStarted() runs inside the live gesture,
    // which iOS needs to resume the context.
    tap(this.soundHintEl, () => {
      void engine.ensureStarted();
    });

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
        // the picker names the *open* strings, so it plays one: any latched
        // finger lifts (a left-hand touch on another lane keeps the stop
        // instead — that's the way to change string with the finger down)
        state.fingerOn = false;
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
    // ☰ menu: meta controls (help, display toggles) live behind one button so
    // they never compete with the play controls for corner space
    const menu = $("#menu");
    const menuBtn = $("#menuBtn");
    const scrim = $("#menuScrim");
    const menuOpen = () => !menu.classList.contains("hidden");
    const setMenu = (open: boolean) => {
      menu.classList.toggle("hidden", !open);
      scrim.classList.toggle("hidden", !open);
      menuBtn.setAttribute("aria-expanded", String(open));
    };
    tap(menuBtn, () => setMenu(!menuOpen()));
    tap($("#menuClose"), () => setMenu(false));
    tap($("#menuHelp"), () => {
      setMenu(false);
      help.classList.remove("hidden");
    });
    // a toggle keeps the menu open so the tick is seen flipping
    tap($("#menuNodes"), () => {
      state.markers = !state.markers;
      notify();
    });
    // Guides: a native select (no tap() — that would preventDefault the very
    // pointerdown that opens its dropdown). The guide lines show in either
    // finger mode, so the select never grays out.
    const guideSel = $<HTMLSelectElement>("#guideSel");
    guideSel.addEventListener("change", () => {
      state.guides = guideSel.value as GuideMode;
      guideSel.blur(); // hand the keys back to playing (G/D/A/E, digits…)
      notify();
    });
    // "Snap to guides" applies to a *pressed* finger, so it grays out in
    // Touch mode (where "Snap to nodes" takes over below) — and with the
    // guides off there is nothing to snap to, so it grays out then too
    tap($("#menuSnap"), () => {
      if (state.leftMode === "touch" || state.guides === "off") return;
      state.snap = !state.snap;
      notify();
    });
    tap($("#menuSnapNodes"), () => {
      if (state.leftMode !== "touch") return; // grayed out under a pressed finger
      state.snapNodes = !state.snapNodes;
      notify();
    });
    // the repo link is a real anchor (default navigation opens a new tab); just
    // close the menu behind it — no tap()/preventDefault, which would swallow
    // the navigation
    $("#menuGithub").addEventListener("click", () => setMenu(false));
    // pressing anywhere outside dismisses the menu (capture phase runs before
    // the target's own tap() handler, and the button itself is excluded so
    // its toggle still sees the menu open)
    window.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Node;
        if (menuOpen() && !menu.contains(t) && !menuBtn.contains(t)) setMenu(false);
      },
      true
    );

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
        } else if (e.key === "Escape" && menuOpen()) {
          setMenu(false);
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    // ? opens the help dialog (mirrors the menu's "How to play…" item)
    window.addEventListener("keydown", (e) => {
      if (e.key === "?" && !helpOpen()) help.classList.remove("hidden");
    });
    // auto-open help on the first visit only; the ☰ menu reopens it
    let seen = false;
    try {
      seen = localStorage.getItem(HELP_SEEN_KEY) === "1";
    } catch {
      /* storage unavailable — treat as first visit */
    }
    if (!seen) help.classList.remove("hidden");
  }

  /** Position (0..1 from the nut) the cursor is hovering over, or null, and
   * the string lane a touch there would catch (it may differ from the
   * selected string — touching another lane moves the finger to it). */
  private hoverS: number | null = null;
  private hoverLane = state.stringIdx;

  setHoverPosition(s: number | null, lane = state.stringIdx): void {
    this.hoverS = s;
    this.hoverLane = lane;
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
    const nodes = this.root.querySelector("#menuNodes") as HTMLButtonElement;
    nodes.classList.toggle("on", state.markers);
    nodes.setAttribute("aria-checked", String(state.markers));
    // the Guides select is always live (the lines draw in either finger
    // mode); the two snap rows swap roles with the finger mode — guide
    // snapping works under a pressed finger (and needs guides to exist),
    // node snapping under a harmonic touch
    const touch = state.leftMode === "touch";
    const guideSel = this.root.querySelector("#guideSel") as HTMLSelectElement;
    guideSel.value = state.guides;
    const snap = this.root.querySelector("#menuSnap") as HTMLButtonElement;
    const snapOff = touch || state.guides === "off";
    snap.classList.toggle("disabled", snapOff);
    snap.setAttribute("aria-disabled", String(snapOff));
    snap.classList.toggle("on", state.snap);
    snap.setAttribute("aria-checked", String(state.snap));
    const snapNodes = this.root.querySelector("#menuSnapNodes") as HTMLButtonElement;
    snapNodes.classList.toggle("disabled", !touch);
    snapNodes.setAttribute("aria-disabled", String(!touch));
    snapNodes.classList.toggle("on", state.snapNodes);
    snapNodes.setAttribute("aria-checked", String(state.snapNodes));
  }

  /** Per-frame tuner + position readout update. */
  updateMeters(): void {
    // Audio-status pill: the engine prewarms at page load but the context
    // stays muted until the first user gesture (autoplay policy) — and on a
    // slow first visit the worklet itself may still be loading. Say which,
    // rather than letting a responsive-but-silent string read as broken.
    const hint = engine.running ? "" : engine.started ? "🔇 Tap for sound" : "🔇 Sound loading…";
    if (hint !== this.soundHintText) {
      this.soundHintText = hint;
      if (hint) this.soundHintEl.textContent = hint;
      this.soundHintEl.classList.toggle("off", hint === "");
    }
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
      // blank (not an em-dash — that reads as a drag handle on the panel);
      // the nbsp holds the line's height so the panel doesn't shrink
      this.noteEl.innerHTML = "&nbsp;";
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
      // guide on the *hovered* lane: a touch there would catch that string
      const hf0 = STRINGS[this.hoverLane].spec.f0;
      const n = freqToNote(hf0 / (1 - fingerStop(this.hoverS)));
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
