/** DOM heads-up display: tool/string pickers, technique controls, tuner. */
import { state, notify, subscribe, STRINGS, freqToNote, Tool, LeftMode } from "../state";
import { engine } from "../audio/engine";

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
      (s, i) => `<button class="seg str" data-str="${i}">${s.name[0]}<sub>${s.name.slice(1)}</sub></button>`
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
        <button class="seg lm" data-lm="touch">Touch&nbsp;(harm.)</button>
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
    <div class="panel bottom">
      <label>Bow force <input type="range" id="force" min="0.05" max="1.2" step="0.01"></label>
      <label>Bow speed <input type="range" id="speed" min="0.05" max="0.5" step="0.01"></label>
      <label>Slow-mo <input type="range" id="slowmo" min="0.4" max="4" step="0.1"></label>
      <label class="chk"><input type="checkbox" id="autobow"> Auto-bow</label>
      <label class="chk"><input type="checkbox" id="vibrato"> Vibrato</label>
      <label class="chk"><input type="checkbox" id="markers"> Markers</label>
      <label class="chk"><input type="checkbox" id="snap"> Snap</label>
      <button id="challengeBtn" class="seg accent">▶ Challenge</button>
      <button id="helpBtn" class="seg">?</button>
    </div>
    <div class="overlay hidden" id="help">
      <div class="card">
        <h2>How to play</h2>
        <p><b>Right hand</b> (below the fingerboard): with the <b>Bow</b>, press and drag
        sideways — stroke speed is bow speed, vertical position chooses
        <i>sul&nbsp;tasto&nbsp;⇠⇢&nbsp;sul&nbsp;ponticello</i>, and the force slider (or pen/touch
        pressure) sets bow weight. Too little force whistles, too much crunches.
        With <b>Pick</b>/<b>Pizz</b>, grab the string, bend it sideways and release.</p>
        <p><b>Left hand</b> (on the fingerboard): click to place a finger — it stays
        (latches) so you can bow with the mouse. Drag for glissando. Quick-tap the
        finger (or press <kbd>Esc</kbd> / <b>Lift</b>) to lift it. In <b>Touch</b> mode the
        finger only brushes the string: touch a glowing node to sound a natural
        harmonic.</p>
        <p><b>Multi-touch</b>: hold a stop with one finger while bowing with another.</p>
        <p>Try: <i>auto-bow on</i>, then slide the bow toward the bridge (ponticello
        glassiness) or over the fingerboard (tasto flute); crank bow force at low
        speed for the raucous regime; touch ½, ⅓, ¼ nodes for harmonics.</p>
        <button class="seg accent" id="closeHelp">Close</button>
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
      b.addEventListener("click", () => {
        state.tool = b.dataset.tool as Tool;
        notify();
      })
    );
    this.root.querySelectorAll<HTMLButtonElement>(".lm").forEach((b) =>
      b.addEventListener("click", () => {
        state.leftMode = b.dataset.lm as LeftMode;
        notify();
      })
    );
    this.root.querySelectorAll<HTMLButtonElement>(".str").forEach((b) =>
      b.addEventListener("click", () => {
        state.stringIdx = Number(b.dataset.str);
        void engine.ensureStarted().then(() => engine.setString(STRINGS[state.stringIdx].spec));
        notify();
      })
    );
    $("#lift").addEventListener("click", () => {
      state.fingerOn = false;
      notify();
    });

    const force = $<HTMLInputElement>("#force");
    force.addEventListener("input", () => (state.bowForce = Number(force.value)));
    const speed = $<HTMLInputElement>("#speed");
    speed.addEventListener("input", () => (state.autoBowSpeed = Number(speed.value)));
    const slowmo = $<HTMLInputElement>("#slowmo");
    slowmo.addEventListener("input", () => (state.slowMo = Number(slowmo.value)));
    const autobow = $<HTMLInputElement>("#autobow");
    autobow.addEventListener("change", () => {
      state.autoBow = autobow.checked;
      void engine.ensureStarted().then(() => {
        if (!state.autoBow) engine.setBowOn(false);
      });
    });
    const vibrato = $<HTMLInputElement>("#vibrato");
    vibrato.addEventListener("change", () => {
      state.vibrato = vibrato.checked;
      engine.vibratoOn = vibrato.checked;
    });
    const markers = $<HTMLInputElement>("#markers");
    markers.addEventListener("change", () => {
      state.markers = markers.checked;
      notify();
    });
    const snap = $<HTMLInputElement>("#snap");
    snap.addEventListener("change", () => (state.snap = snap.checked));

    $("#helpBtn").addEventListener("click", () => $("#help").classList.remove("hidden"));
    $("#closeHelp").addEventListener("click", () => $("#help").classList.add("hidden"));
    // show help on first load
    $("#help").classList.remove("hidden");
  }

  get challengeButton(): HTMLButtonElement {
    return this.root.querySelector("#challengeBtn") as HTMLButtonElement;
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
    (this.root.querySelector("#speed") as HTMLInputElement).value = String(state.autoBowSpeed);
    (this.root.querySelector("#slowmo") as HTMLInputElement).value = String(state.slowMo);
    (this.root.querySelector("#autobow") as HTMLInputElement).checked = state.autoBow;
    (this.root.querySelector("#vibrato") as HTMLInputElement).checked = state.vibrato;
    (this.root.querySelector("#markers") as HTMLInputElement).checked = state.markers;
    (this.root.querySelector("#snap") as HTMLInputElement).checked = state.snap;
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
      const txt = m.slipRatio > 0.55 ? "raucous" : m.slipRatio > 0.005 ? "stick–slip" : "stuck";
      this.slipEl.textContent = txt;
      this.slipEl.className = "slip " + (m.slipRatio > 0.55 ? "bad" : m.slipRatio > 0.005 ? "good" : "warn");
    } else {
      this.slipEl.textContent = "";
    }
    // note under the finger
    if (state.fingerOn) {
      const f0 = STRINGS[state.stringIdx].spec.f0;
      const fr = f0 / (1 - state.fingerPos);
      const n = freqToNote(fr);
      if (n) this.posNoteEl.textContent = `stop: ${n.name} ${n.cents >= 0 ? "+" : ""}${n.cents}¢`;
    } else {
      this.posNoteEl.innerHTML = "&nbsp;";
    }
  }
}
