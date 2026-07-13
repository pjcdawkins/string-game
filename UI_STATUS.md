# UI feature status

A quick reference for which on-screen controls actually do something, kept
separate from the README so it's easy to check (and update) as the HUD grows
a settings drawer and keyboard shortcuts. Update this file whenever a control
is added, removed, or hidden.

## Layout

All four strings are drawn down the centre of the viewport (nut at the top,
bridge near the bottom), fanning apart slightly toward the bridge as on a
real setup and back in again below it, running off-screen toward the
out-of-view tailpiece — G, D, A, E left to right, i.e. IV..I in classical
numbering (`src/scene/lanes.ts`). One string *sounds* at a time — the selected
string draws at full contrast and vibrates over the three faint idle ones —
but the left hand moves between strings directly: a touch on the board catches
the nearest lane (the current string wins near-ties), switching the sounding
string and bringing the bow with it. The HUD picker and the G/D/A/E keys still
switch strings too.

The controls are stationed by hand, mirroring the instrument (nut at the
top, bridge at the bottom): the **left hand's** controls — string picker and
Press/Touch/Lift — sit **top-left**, beside where the left hand plays, and
the **right hand's** — Bow/Pizz/Pick and bow pressure — sit **bottom-right**,
by the bridge. The tuner (feedback, not a control) and the ☰ menu (meta:
help, display toggles, repo link) take the top-right. On narrow portrait
screens (`max-width: 600px`, see `src/style.css`) the stations dock into the
gutters and onto the **upper bouts**, keeping the centre column clear: the
left-hand string/technique controls run down the top-left edge; the ☰ button
sits top-right with the **tuner tucked just beneath it**; and the right-hand
controls — **Pressure over Bow/Pizz/Pick** — sit lower over the **upper-right
bout**, near the bowing/plucking position. So neither the fingerboard (left
hand, up the centre) nor the bridge (right hand, bottom centre) is covered.
The narrow tuner is a slimmed, display-only pill (`pointer-events: none`, Hz
readout dropped, matched to the pressure panel's width) so a bow stroke begun
over it still reaches the string. On those same small screens the camera
zooms in on the playable string — the nut-to-bridge stretch fills the height,
cropping the body flanks and the belly below the bridge (`applyZoom` in
`src/scene/scene.ts`); the screen↔string mapping and the bow scale follow the
zoom automatically, so fingering and bowing stay accurate.

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

- **String picker** — G / D / A / E (top-left, with the left-hand controls);
  switches to the *open* string, lifting any latched finger (moving the
  finger between strings with the stop kept is the left-hand touch on the
  board instead).
- **Finger mode** — Press / Touch (harmonic) / Lift (top-left).
- **Tool picker** — Bow / Pizz / Pick (bottom-right with the right-hand
  controls, over the upper-right bout on narrow screens). On desktop the three
  buttons share one fixed width; on narrow screens they take the same modest
  padding as Press/Touch/Lift and stretch to a uniform label-width, so the
  panel stays clearly narrower than the tuner/pressure pills.
- **Bow pressure slider** — in its own panel (bottom-right, or over the
  upper-right bout *above* the tool picker on narrow screens); sets
  `state.bowForce`.
- **Tuner** — note, cents needle, frequency, stick–slip/pressed/surface
  readout, and the note-under-the-finger / hover-note guide (top-right, below
  the ☰ button; the guide lives here rather than in a picker panel so no
  picker's width tracks the text). With no pitch the note line is left blank
  (an em-dash there read as a drag handle on the panel). The panel itself is
  fixed-width, sized for the worst-case readout, and the readout row holds its
  height while silent — the box must not breathe as digits come and go or sound
  starts and stops. On narrow screens it slims to a display-only pill
  (`pointer-events: none`, no Hz) tucked into the top-right corner just beneath
  the ☰ button.
- **☰ menu** (top-right) — a floating sidebar drawer (over a dimming scrim;
  press the ✕, the scrim, `Esc`, or outside it to close). *How to play…* opens
  the help overlay (also auto-opens on first visit, and `?` reopens it),
  *Node markers* is a checkbox row (filled tick + highlighted row when on)
  toggling `state.markers`, the harmonic-node dots drawn by
  `src/scene/scene.ts` over the whole vibrating length — nut (or firm stop)
  to bridge, past the fingerboard's end, from the shared node set in
  `src/harmonics.ts` — *Guides* is a select (Off / Chromatic / Major /
  Minor; chromatic is the default) ruling subtle fret-like lines across the
  fingerboard only, one per degree of a scale rooted on the open string
  (major/minor in quarter-comma meantone, chromatic in 12-EDO — the shared
  scale set in `src/guides.ts`), *Snap to guides* is a checkbox (on by
  default) lightly magnetising a pressed finger onto that same scale (see
  `src/input/snap.ts`; the snap alone carries on past the board's end),
  *Snap to nodes* is a checkbox (also on by default) doing the same for a
  Touch-mode finger and the natural-harmonic nodes, and *GitHub repo* (with
  the GitHub mark) links out to the source. The Guides select is always
  live; the two snap rows swap roles with the finger mode — *Snap to guides*
  grays out in Touch mode (and whenever Guides is Off), the node toggle in
  Press mode. A future About entry belongs here too.
- **Left-hand touch gestures** (`src/input/interactions.ts`) — a tap on the
  board stops the nearest string lane (touching another string moves the
  finger, and the bow, there); a drag glissandos; a tap on the latched finger
  leaves it latched, while flicking it sideways off its string lifts it; a tap
  in the top-left corner of the play area lifts the hand, and a tap at the nut
  lifts it *and* selects the tapped lane — that string, open.
- **Keyboard shortcuts** (`src/input/keyboard.ts`) — arrows bow (`→` down
  bow, `←` up bow, `↑`/`↓` contact point), `Space` (held) auto-bows,
  `[`/`]` (held) ramp the bow pressure, digits (held) add their semitones
  above the open string, `Shift` makes pitch changes glide (portamento),
  `0` open string, `Esc` lifts the finger. All combine mid-stroke.

## Implemented but hidden (no HUD control right now)

These work end-to-end in the audio/visual model but currently have nothing
in the HUD to switch them on — they're candidates for the ☰ menu or
keyboard shortcuts:

- **Auto-bow speed** (`state.autoBowSpeed` in `src/state.ts`) — auto-bow
  itself is operable now (hold `Space`), and its stroke length now tracks this
  speed (faster = shorter, visibly quicker strokes), but the speed value still
  has no on-screen control.
- **Slow-mo rate** (`state.slowMo`) — the visual vibration's caricature
  speed, consumed by `src/scene/visualString.ts`.

## Removed entirely (did not work)

- **Vibrato** — used to wobble the stopped-finger position, but had no
  audible effect. Removed along with its engine support (the former
  `vibratoOn`/`tick()` machinery in `src/audio/engine.ts`).
