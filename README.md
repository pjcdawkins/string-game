# Bowed String — a playable physical model in the browser

A high-fidelity simulation of a single violin string that runs entirely in the
browser: a visualization, audio synthesis, learning/teaching tool, and a little
game. Vite + TypeScript + Three.js for rendering; the sound is a real physical
model running in an AudioWorklet.

```bash
npm install
npm run dev      # open the printed URL (Chromium recommended for dev mode)
npm test         # physics unit tests (pitch, harmonics, Helmholtz motion…)
npm run build    # production build (worklet bundles to a self-contained file)
```

## What you can do

- **Bow** the string: drag sideways. Stroke speed is fully gestural — the
  drag velocity *is* the bow speed; vertical
  position = contact point, from well over the fingerboard (*sul tasto*:
  round, flutey) down to the bridge (*sul ponticello*: glassy, rich in upper
  partials); bow force from the slider, or pen/touch pressure. Too little
  force skates on the surface, too much chokes and crunches — the
  Schelleng-diagram regimes, and the HUD reports which one you are in
  (*surface / stick–slip / pressed*). Driving a string hard (especially the
  low ones, sul tasto, fast bow) pulls it audibly sharp via tension
  modulation, as on the real instrument.
- **Pluck** with a plectrum (hard, bright) or a fingertip (soft, round): grab
  the string, bend it, release. The bend point shapes the spectrum (comb
  filtering — pluck at 1/4 and the 4th harmonic family is missing).
- **Stop** the string anywhere on the fingerboard: click to latch a finger,
  drag for glissando, quick-tap to lift, `Esc` to clear. Multi-touch: hold a
  stop while bowing. The bow and plucks always stay on the bridge side of a
  stopped finger — the nut-side portion of the string is not modelled.
- **Harmonics**: switch the left hand to *Touch* mode and brush a node
  (½, ⅓, ¼ … — with a firm stop down they are drawn relative to the stopped
  length) — the model kills every partial without a node there, just like a
  real flageolet.
- **Play from the keyboard** (desktop): hands sit like on the instrument.
  Right hand — `→` is a down bow, `←` an up bow (the stroke dies away when
  you run out of bow; flip direction to keep it singing), holding `Space`
  sustains an automatic détaché (release to stop; the arrows stay manual
  and override it while held), `↑`/`↓` slide the contact point toward the
  nut/bridge, and holding `[`/`]` eases off / leans into the string (bow
  pressure). Left hand on the number row — digits are semitones above the
  open string (`1` = semitone, `2` = whole tone … `9`) and held digits
  *add*, so `4`+`3` stops a fifth and `9`+`3` an octave; releasing a digit
  peels its interval off again, `0` is the open string, and holding `Shift`
  turns pitch changes into portamento slides. Everything combines
  mid-stroke — slide the contact point, swell, and change fingers while
  bowing (a finger landing under a live stroke re-articulates with a little
  extra bow weight, as a player would, so the new note speaks instead of
  choking).
- **Slow-motion string**: the visual vibration runs at an adjustable visual
  rate. Bowing draws true Helmholtz motion (a corner travelling around a
  parabolic envelope); plucks draw the standing-wave mode sum seeded by the
  pluck point; harmonics show only the surviving modes.

Some of these (auto-bow, the node-marker dots, the slow-mo rate) are
implemented but currently have no HUD control — see
[UI_STATUS.md](UI_STATUS.md) for the full breakdown of what's operable from
the UI today.

## Architecture

```
src/
  audio/
    dsp/StringSim.ts        the physical model (pure TS, no Web Audio)
    dsp/filters.ts          delay line, one-pole, allpass, biquad, smoother
    processor.worklet.ts    thin AudioWorklet wrapper (k-rate params + port)
    engine.ts               main-thread engine: context, node, meter
    pitch.ts                YIN pitch detector on the analyser output
  scene/                    Three.js: scene, slow-mo string, tool meshes
  input/interactions.ts     pointer gestures -> bow/pluck/finger, multi-touch
  ui/hud.ts                 HUD (DOM): pickers, sliders, tuner, help
test/stringsim.test.ts      physics regression tests (run in Node)
```

### The audio model

`StringSim` is a digital waveguide using velocity waves (string impedance
normalised to Z = 1), split into three segments by two scattering junctions:

```
nut |-- A --| finger |-- B --| bow/pluck |-- C --| bridge
```

- **Nut**: near-unity inverting reflection.
- **Finger junction**: a variable damper of resistance `Rf` pressed on the
  string. The same junction continuously covers the whole left-hand technique
  space: `Rf = 0` is the open string; small `Rf` is a harmonic touch (it
  absorbs every mode without a node at that point); large `Rf` approaches a
  rigid termination — a stopped note whose pitch is set by the finger→bridge
  length, with realistic leakage/damping in between.
- **Bow junction**: the McIntyre–Schumacher–Woodhouse stick–slip friction
  model with a hyperbolic kinetic friction curve, solved in closed form (a
  quadratic per sample, plus the static-friction stick test). Bow position
  (the B/C split) gives sul tasto/ponticello naturally, and the contact
  point additionally controls the friction-curve knee (Cremer corner
  rounding grows with bow–bridge distance) and the bridge brightness — so
  ponticello turns glassy and overtone-rich while tasto rounds off, far more
  audibly than the comb effect alone. Bow force and speed span
  surface-sound → Helmholtz → pressed/raucous regimes; a little force noise
  supplies the breath of the bow hair. Every stroke starts with a brief
  extra-weight "bite" (as players do), which reliably captures the
  fundamental Helmholtz regime instead of the double-slip octave.
- **Tension modulation**: a slow amplitude tracker shortens all delay lines
  slightly when the string is driven beyond ordinary amplitudes, so hard,
  fast bowing goes sharp — scaled per string (strongest on G, barely on E).
- **Plucks** are raised-cosine force pulses injected at the interaction
  point; pulse duration encodes implement width/hardness (plectrum ≈ 0.7 ms,
  fingertip ≈ 5 ms).
- **Bridge**: inverting reflection through a one-pole loss/brightness filter
  plus two first-order allpasses for string stiffness (dispersion /
  inharmonicity); their group delay is compensated in the loop tuning. The
  transmitted bridge force drives a small modal **body filter** (eight
  violin-ish resonances) and a DC blocker, with a soft safety saturator.
- Per-string presets (G/D/A/E) vary f0, brightness, loss and stiffness.

Delay-line lengths are slewed per sample, so finger glissandi and bow
repositioning are click-free.

### Why no WASM?

Measured cost of the full model (bowing + stopped finger + body filter) is
**≈1% of realtime** in Node on this machine — a single string in optimised
JIT-compiled TypeScript has ~100× headroom inside the AudioWorklet thread.
WASM would buy nothing here; it becomes interesting for multi-string
instruments with sympathetic coupling or FDTD stiff-string models.

### Testing strategy

The model is deliberately split from the worklet wrapper so the physics runs
in Node. `npm test` verifies, with an autocorrelation pitch estimator:

- a plucked open string sounds at f0 and decays;
- bowing sustains a tone at f0 (Helmholtz regime reached from rest);
- a firm stop at ¼ of the string raises the pitch a perfect fourth;
- a light touch at the midpoint yields the octave harmonic;
- bowing closer to the bridge brightens the spectrum (≥2× contrast);
- bowing right next to the bridge stays in tune (regression for a
  delay-clamp bug that played flat);
- tension modulation sharpens loud playing on a nonlinear string;
- silence stays silent and every sample stays finite.

### Visual model

The visual vibration is intentionally *not* the audio model (real string
motion is hundreds of Hz): it is a slow-motion caricature driven by live
RMS/slip telemetry from the worklet — Helmholtz corner motion while bowing,
modal standing waves after plucks, node-filtered modes for harmonics, and a
string that visibly depresses onto the fingerboard under the finger.

## Notes & known limits

- Dev mode serves the worklet as an ES module with imports, which Chromium
  supports; the production build emits a self-contained worklet file that
  works in all worklet-capable browsers.
- One string at a time (the picker swaps presets). No torsional waves, no
  finite-width bow-hair ribbon, no two-point finger model yet — see ideas
  below.
- Ideas next: four strings + sympathetic coupling, recorded-impulse body
  convolution, bow tilt/hair width, pizz damping (palm mute), practice games.
