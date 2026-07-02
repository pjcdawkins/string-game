# UI feature status

A quick reference for which on-screen controls actually do something, kept
separate from the README so it's easy to check (and update) as the HUD grows
a settings drawer and keyboard shortcuts. Update this file whenever a control
is added, removed, or hidden.

## Layout

The string is drawn down the centre of the viewport (nut at the top, bridge
near the bottom). On wide screens the controls sit in the four corners. On
narrow portrait screens (`max-width: 600px`, see `src/style.css`) they dock
into the left/right gutters and the strip below the bridge instead, so the
whole vertical string stays reachable for fingering and bowing.

The HUD and the WebGL scene both follow the system colour scheme
(`prefers-color-scheme`, applied live — there is no in-app toggle): the CSS
variables live in `src/style.css` and the scene palette in
`src/scene/theme.ts`, whose `--bg` and `bg` values must stay in sync.
`node e2e/screenshot.mjs` captures a screenshot of the built app in each
scheme for design review.

## Operable now

All HUD buttons act on `pointerdown` rather than `click` (see `tap()` in
`src/ui/hud.ts`), so they respond to *any* finger — including a second finger
tapped mid-stroke while the first holds a bow gesture on the canvas. Browsers
only fire `click` for the primary pointer, which used to make string switching
impossible until the bowing finger lifted.

- **Tool picker** — Bow / Pick / Pizz (top-left).
- **Left hand** — Press / Touch (harmonic) / Lift (top-left).
- **String picker** — G / D / A / E (top-right).
- **Tuner** — note, cents needle, frequency, stick–slip/pressed/surface
  readout (top-right).
- **Bow pressure slider** — the only slider in the bottom-left panel; sets
  `state.bowForce`.
- **Help (`?`)** — opens the "How to play" overlay.
- **Keyboard shortcuts** (`src/input/keyboard.ts`) — arrows bow (`→` down
  bow, `←` up bow, `↑`/`↓` contact point), `Space` (held) auto-bows,
  `[`/`]` (held) ramp the bow pressure, digits (held) add their semitones
  above the open string, `Shift` makes pitch changes glide (portamento),
  `0` open string, `Esc` lifts the finger. All combine mid-stroke.

## Implemented but hidden (no HUD control right now)

These work end-to-end in the audio/visual model but currently have nothing
in the HUD to switch them on — they're candidates for a future settings
drawer or keyboard shortcuts:

- **Auto-bow speed** (`state.autoBowSpeed` in `src/state.ts`) — auto-bow
  itself is operable now (hold `Space`), but its stroke speed still has no
  control.
- **Slow-mo rate** (`state.slowMo`) — the visual vibration's caricature
  speed, consumed by `src/scene/visualString.ts`.
- **Node markers** (`state.markers`) — the glowing harmonic-node dots drawn
  by `src/scene/scene.ts`; the physics and rendering are intact, they're just
  hidden by default (`state.markers` defaults to `false` with no toggle to
  flip it).

## Removed entirely (did not work)

- **Vibrato** — used to wobble the stopped-finger position, but had no
  audible effect. Removed along with its engine support (the former
  `vibratoOn`/`tick()` machinery in `src/audio/engine.ts`).
