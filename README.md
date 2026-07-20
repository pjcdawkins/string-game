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

- **Bow** the string: drag sideways. The bow is drawn at the true proportion
  of a full-size bow to a full-size violin (its hair ≈ 2× the speaking string),
  scaling down only to fit a narrow viewport. Stroke speed is fully gestural —
  the drag velocity *is* the bow speed, mapped 1:1 in world space (the contact
  tracks under the pointer) with pointer-style acceleration on top: quick
  flicks are progressively amplified, in the sound and in the bow's travel
  alike. So a full stroke is a big, deliberate gesture on a wide desktop bow
  and a quick screen-wide flick on a narrow phone, and lands anywhere from a
  ~0.5 s special-effect flick to a minute-long creep — an unhurried drag being
  a singing ~5 s. A full sweep now reaches both the tip and the frog. Vertical
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
  filtering — pluck at 1/4 and the 4th harmonic family is missing). Grabbing
  can start from beside the board too — reach in from the flank and flick — so
  an open string can be plucked *sul tasto*, anywhere up its length.
- **Stop** the string anywhere on the fingerboard: a tap on the board latches
  a finger, a drag glissandos — and the drag can carry the finger on past the
  end of the board toward the bridge, higher in pitch than the board itself
  reaches (as far as a bow-width from the bridge). The tap catches whichever
  string lane it is nearest, so touching a different string moves the finger —
  and with it the bow, which always plays the finger's string — over to it:
  all four strings are playable by touch alone, though the bow drives one at a
  time. Tapping a latched finger leaves it latched; to lift it, flick it
  sideways off its string, tap the top-left corner of the play area (or above
  the nut — where the tap also selects the lane it lands on: every string is
  open at the nut, so tapping a string there plays it open, as the picker's
  G/D/A/E buttons do), or press `Esc`. The board, right over
  the strings, is the left hand's; the bow and plucks live below it or reach in
  from either flank. Multi-touch: hold a stop with one finger and bow or pluck
  with another — a second touch on the board, bridge-side of the stop, plays
  over the board (*sul tasto*). The bow and plucks always stay on the bridge
  side of a stopped finger — the nut-side portion of the string is not modelled.
- **Hear the other strings ring**: all four strings are always alive,
  terminated on one shared bridge, and the bridge couples them — play a note
  whose partials coincide with another string's (stop E on the A string, or
  just play the open A and listen for the D and E) and that string blooms
  sympathetically, gently, exactly as on the instrument; a semitone off and
  it stays silent. The halo rings on after the note stops. The open strings
  are tuned in pure 3:2 fifths from A440 — as a violinist tunes, not 12-EDO —
  which is what makes the cross-string coincidences exact. Switching strings
  no longer silences anything: the string you leave decays naturally.
- **Guides**: the ☰ menu's *Guides* select rules subtle light-gray, fret-like
  lines across the fingerboard (only there — visual markers, not physical
  frets), one at each degree of a scale rooted on the open string: a
  chromatic scale in plain 12-EDO (the default), or each string's own major
  or minor scale, tuned in quarter-comma meantone as befits a violin (pure
  5/4 thirds). *Off* clears the board. As with a learner's tape, you centre
  the fingertip *on* the line: each line sits one finger radius nut-ward of
  where its note speaks (a firm press stops the string at the bridge-side
  edge of the fingertip's contact patch, not under its middle), and a
  snapped finger lands dead-centre on its line.
- **Snap to guides**: a toggle beneath the select (on by default, so notes
  land true out of the box) lightly magnetises the stopping finger onto the
  guides' scale — continuing past the board's end, where the guides stop but
  the string can still be stopped. The snap is a continuous remap: exactly on
  a degree it locks in, between degrees the finger glides freely, so
  glissandi survive — they just linger on the notes. In *Touch* mode it gives
  way to a *Snap to nodes* toggle (also on by default), which magnetises the
  harmonic nodes instead.
- **Harmonics**: switch the left hand to *Touch* mode and brush a node
  (½, ⅓, ¼ … — with a firm stop down they are drawn relative to the stopped
  length) — the model kills every partial without a node there, just like a
  real flageolet. Unlike a firm stop, a light touch damps the string under
  the *middle* of the finger, so you centre the fingertip right on a node
  marker to make its harmonic speak.
- **Play from the keyboard** (desktop): hands sit like on the instrument.
  Right hand — `→` is a down bow, `←` an up bow at a fixed singing speed
  (a full length takes ~3.5 s, the same medium band as an unhurried pointer
  stroke; the stroke dies away when you run out of bow, so flip direction to
  keep it singing), holding `Space`
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
- **Light & dark**: the whole interface — the HUD and the drawn instrument
  alike — follows the system colour scheme, switching live when it changes.

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
- All four strings run all the time, coupled at a shared bridge junction
  (sympathetic resonance, ring-over across string switches, one body driven
  by the total bridge force — see the notes in `src/audio/dsp/ViolinSim.ts`).
  The bow and the single left-hand finger act on the selected string; the
  others ride along as open strings. A simplified lossy torsional impedance now
  damps the bow point during slip (widening the attack wedge; see below); still
  no finite-width bow-hair ribbon and no two-point finger model — see ideas
  below.
- Ideas next: recorded-impulse body convolution, bow tilt/hair width, pizz
  damping (palm mute), fingers on the unplayed strings (retuning their
  sympathetic pitches, as a real stopped string's sympathy moves), practice
  games.
- On bow-attack reliability (why attacks are enveloped the way they are, the
  torsional-loss upgrade already in, and the ones still to come — thermal
  friction, finite bow width — that would make attacks as responsive as a real
  violin's), see [MODEL_NOTES.md](MODEL_NOTES.md).
