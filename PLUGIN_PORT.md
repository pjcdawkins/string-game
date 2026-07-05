# Shipping this as a DAW plugin — the extraction sketch

Goal: run the same instrument as (a) the web app it is today and (b) a native
DAW plugin (VST3 / AU / CLAP), **audio and visualizer both**, without a
ground-up rewrite and without forking the code into two divergent projects.

The good news is structural: the hard split was already made. This document
sketches the concrete refactor that turns the existing implicit seams into
explicit, backend-agnostic ones, so a plugin backend can drop in beside the web
one. Everything here is TypeScript-side and needs no plugin toolchain to start.

---

## 1. The two seams (one already existed, one is now named)

The app has exactly two boundaries between "the instrument" and "the browser":

### Seam A — control + telemetry: `StringBackend`

`src/input/interactions.ts` and `src/input/keyboard.ts` drive the sound through
a tiny imperative API on `Engine`, and `main.ts` polls telemetry back off it:

```
player gesture ──▶ engine.setBow / setFinger / pluck / setString / mute
                                                     │
visual frame  ◀── engine.meter (rms, slipRatio, freq, bowing)
```

That surface is now named `src/audio/backend.ts` → `interface StringBackend`,
and `Engine` is declared `implements StringBackend`. Nothing changed at runtime;
the compiler now just *enforces* that the web engine satisfies the contract a
plugin backend must also satisfy. The seven continuous controls are exactly the
worklet's `parameterDescriptors` — i.e. already a plugin automation manifest.

### Seam B — the visualizer: `VisualInputs` (already pure)

`VisualString.update(dt, inp: VisualInputs)` in `src/scene/visualString.ts`
already takes a plain telemetry struct — `{ grabbed, fingerOn, fingerPos,
fingerPressure, bowing, bowEngaged, bowVelSign, rms, slipRatio, slowMoHz }` —
with **no Web Audio dependency**. The underlying travelling-wave object
(`WaveString`) is pure math too. The visualizer is therefore already a pure
function of a telemetry struct; both backends feed it the identical struct.

So the whole port reduces to: **implement `StringBackend` a second way, and
mount the existing visualizer somewhere the plugin can show it.**

---

## 2. What is browser-only vs. genuinely portable

```
src/audio/dsp/StringSim.ts   PORTABLE   pure math, zero deps, ~1% realtime
src/audio/dsp/filters.ts     PORTABLE   pure math, zero deps
src/state.ts                 PORTABLE   plain data (specs, helpers)
src/scene/*  (Three.js)      WEB-TECH   reusable inside an embedded WebView
src/ui/hud.ts  (DOM)         WEB-TECH   reusable inside an embedded WebView
src/input/*  (pointer/kbd)   WEB-TECH   reusable inside an embedded WebView
src/audio/engine.ts          WEB-ONLY   AudioContext/worklet — the web backend
src/audio/processor.worklet  WEB-ONLY   the web backend's realtime shell
```

Note the middle block: the scene, HUD and input layers are *web technology* but
not *browser-tab-only*. A DAW plugin can host them in an embedded WebView, so
they are reused, not rewritten — the only thing that must be reimplemented in a
native language is the ~600-line DSP.

---

## 3. Proposed folder split (additive, non-breaking)

Draw a line between a backend-agnostic **core** and the web **shell**:

```
core/                         # no browser globals; runs in Node, worklet, WebView
  dsp/StringSim.ts            # (moved) the model
  dsp/filters.ts             # (moved)
  strings.ts                 # (moved from state.ts) StringSpec presets + helpers
  backend.ts                 # StringBackend interface  ← the seam
  visual/waveString.ts       # (moved) pure travelling-wave object
  visual/visualString.ts     # (moved) Three.js caricature, driven by VisualInputs

web/                          # the browser shell (today's app, minus core)
  backends/workletBackend.ts # today's engine.ts — implements StringBackend
  audio/processor.worklet.ts
  scene/ ui/ input/ main.ts

test/                         # golden physics tests — now the port's spec too
```

This is a move-and-reimport refactor; no logic changes. The web app keeps
importing everything through the same names. `test/stringsim.test.ts` keeps
passing and becomes the **conformance suite the native port must also pass**.

---

## 4. The plugin side (what's new)

### 4a. Port the DSP (the only mandatory rewrite — and it's small)

`StringSim` + `filters` is ~600 lines of `Float32Array` arithmetic: no closures,
no async, no DOM, no JS-isms. Two options:

- **Native port (recommended for a first plugin):** transcribe to C++ or Rust
  nearly line-for-line. Simpler than embedding a runtime, and the model is tiny.
- **Single source via WASM:** the numeric TS is almost valid AssemblyScript;
  compile to WASM and call it from the realtime callback. Keeps one DSP source
  of truth, at the cost of an RT-safe WASM runtime in the audio thread.

Either way, **gate it on the existing golden tests**: feed identical control
sequences to the port and diff the output against `StringSim`. Pitch, harmonics,
Helmholtz onset, tension-sharpening, finite/silent invariants are all already
asserted — that de-risks the port to near-mechanical work.

### 4b. Plugin shell + parameters

Pick one:

- **CLAP + `nih-plug` (Rust)** — lightweight, open, modern; least boilerplate.
- **JUCE (C++)** — heaviest, but broadest host coverage (VST3/AU/AAX) and, in
  JUCE 8, a first-class `WebBrowserComponent` for the GUI (see 4c).

The seven `StringBackend` continuous controls become the plugin's automatable
parameters; `pluck`/`setString`/`mute` become param-triggers or MIDI events.

### 4c. GUI — reuse the visualizer via an embedded WebView

Load the existing Three.js scene + HUD into the plugin's WebView. A thin native
↔ JS bridge replaces `engine.ts`'s worklet port:

```
       plugin realtime thread                 plugin WebView (JS)
   ┌────────────────────────────┐        ┌──────────────────────────┐
   │ native StringSim.process()  │  params│  input/* gestures         │
   │  (the DSP port)             │◀───────│  → StringBackend calls    │
   │  getState() ──────────────► │  meter │  scene/* + ui/* (as-is)   │
   └────────────────────────────┘───────▶│  visualString.update(...)  │
                                          └──────────────────────────┘
```

The WebView implements `StringBackend` by posting messages across the bridge
instead of setting `AudioParam`s. `scene/`, `ui/` and `input/` load unchanged;
`main.ts`'s frame loop is reused almost verbatim (only its `engine` reference
becomes the bridge backend, and pitch detection reads `meter.freq` instead of
the Web Audio analyser).

> A fully native (OpenGL/JUCE) GUI is the *only* path that requires rewriting
> the visualizer. There's no reason to choose it here — the WebView route reuses
> ~2,000 lines of scene/HUD/input code.

---

## 5. The real design fork: how is the plugin *played*?

This is a product decision, not a language one, and it should be settled before
any plugin code is written. A DAW plugin is normally driven by MIDI notes +
automation, but this instrument's soul is gestural — "the drag velocity *is* the
bow speed." Finger position → MIDI pitch + bend and bow force → aftertouch/CC
map cleanly, but **bow speed and direction have no natural MIDI equivalent**.

Three resolutions, cheapest first:

1. **Gestural-first (truest to the design):** the plugin *is* its WebView
   surface — played by pen/mouse/touch in the plugin window; the host records
   the audio and reads the seven params as automation. Preserves everything.
2. **MPE-driven:** notes→pitch, bend→glissando, pressure→bow force, and bind
   bow velocity to mod-wheel / an expression pedal / an X-Y pad. Keyboard-
   playable, but loses some gesture.
3. **Both:** gestural surface *plus* optional MPE, all seven params exposed as
   host automation.

Recommended v1: **(1)**, with the params exposed so (2)/(3) can follow.

---

## 6. Incremental plan — each step ships on its own

1. **Name the seams.** `backend.ts` interface + `Engine implements StringBackend`
   (done in this branch). Web app unaffected.
2. **Core/shell folder split (§3).** Pure move + reimport; tests stay green.
3. **Port the DSP** to C++/Rust (or WASM), validated against the golden tests.
   Produces a headless native instrument with no GUI yet.
4. **Minimal plugin shell** (CLAP/JUCE) wrapping the port; seven params
   automatable; audible in a DAW, generic GUI. This is already a usable plugin.
5. **WebView GUI:** mount `scene/`+`ui/`+`input/` behind the native bridge —
   full visualizer in the plugin.
6. **Play-model polish:** MIDI/MPE mapping per §5.

Effort for a solid v1 (steps 1–5, gestural WebView plugin that also records
automation): ~2–4 weeks part-time — the DSP port is 1–3 days; the fiddly part is
the cross-platform WebView bridge and asset packaging, not the audio.

---

## 7. Bottom line

No ground-up rewrite. One small, well-tested DSP gets ported (or WASM-compiled);
the visualizer and input layers are reused inside an embedded WebView; the
existing k-rate parameter list is already the automation spec; and the web app
stays live off the same `core/`. The only open question that actually shapes the
work is the play model (§5), not the language.
