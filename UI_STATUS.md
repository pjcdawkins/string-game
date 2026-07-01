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

## Operable now

- **Tool picker** — Bow / Pick / Pizz (top-left).
- **Left hand** — Press / Touch (harmonic) / Lift (top-left).
- **String picker** — G / D / A / E (top-right).
- **Tuner** — note, cents needle, frequency, stick–slip/pressed/surface
  readout (top-right).
- **Bow pressure slider** — the only slider in the bottom-left panel; sets
  `state.bowForce`.
- **Help (`?`)** — opens the "How to play" overlay.
- **Keyboard shortcuts** (`src/input/keyboard.ts`) — arrows bow (`→` down
  bow, `←` up bow, `↑`/`↓` contact point), `[`/`]` (held) ramp the bow
  pressure, `1`–`5` (held) stop whole-tone positions with `Shift` a semitone
  lower, `0` open string, `Esc` lifts the finger. All combine mid-stroke.

## Implemented but hidden (no HUD control right now)

These work end-to-end in the audio/visual model but currently have nothing
in the HUD to switch them on — they're candidates for a future settings
drawer or keyboard shortcuts:

- **Auto-bow** (`state.autoBow`, `state.autoBowSpeed` in `src/state.ts`,
  driven from `src/input/interactions.ts`) — sustains a bow stroke with
  bow-change dips so both hands are free.
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
