# Model notes: bow-attack reliability, and where to take the model next

## Torsional loss at the bow (added later than the notes below)

Implements the top item under "Why the model is more capture-prone" below: a
simplified lossy torsional impedance at the bow junction. It lives in the
bow's stick–slip solver in `src/audio/dsp/StringSim.ts` (`tickComplete`), with a
per-string `torsional` amount in `StringSpec` (default 0 = off) set in
`state.ts`.

**The physics, and the one design choice that matters.** The bow rides on the
string *surface*, which twists as well as translates. During a slip the sudden
release spins the string; that twist is heavily damped, so we treat it as a
pure loss that carries off part of the slip instead of launching it all as a
transverse wave. Concretely, a slip moves the transverse junction only
`torsTransFrac = 1/(1 + torsional)` of the way from the incoming (free) velocity
toward the solved slip velocity — the remainder is dissipated. That is a loss
channel *right at the bow point*, where an attack's aperiodic junk lives, so it
damps the spurious double-slip/whistle regimes that a hard attack captures.

The choice that matters: **the shunt acts only in the slip branch; the stick
phase is left exactly as it was** (same threshold, `vJ = vBow`). An earlier,
more "complete" version modelled torsion as an admittance in parallel with the
transverse waveguide across *both* phases — physically tidier, but it raised the
stick threshold, so at low bow speed or crushing force the string stuck
permanently and the note choked to silence (over-pressure and slow bows died).
Restricting the loss to slip keeps every stick-dominated regime — sustained
tone, slow bows, over-pressure, the sul-tasto subharmonic — behaving as before,
because those are stick-heavy and the attack transient is slip-heavy. This is
where the physical benefit concentrates anyway.

**What it does, measured** (harness scripts drive `StringSim` in Node exactly as
the attack-tuning method below; classify settled pitch by autocorrelation over
many stochastic strokes):

- *Widens the attack wedge.* At the hardest attack corner — a stopped note with
  the finger still landing, fast bow ramp, no bite ("land", the narrowest case
  documented below) — G-string capture climbs monotonically from ~92% (off) to
  100% around `torsional` 0.4–0.5 and stays there; the octave-flips it used to
  throw are gone. The effect is a clean, basin-free rise (unlike the parallel
  model, which had a nasty non-monotone hole near 0.2). Easier attacks were
  already reliable, so there the change is neutral — the win is at the edge.
- *Extremes preserved.* Sul ponticello brightness is unchanged within stroke
  noise (still ≫ sul tasto); over-pressure still crunches; a very slow bow still
  speaks; and the extreme-tasto subharmonic (period-doubling on the low strings)
  survives — if anything the added damping brings it out.
- *Cost.* A slight rounding of the Helmholtz corner sul tasto (a real
  Cremer-style effect), and steady level a hair lower — both small.

**Chosen amounts** (`state.ts`): G3 0.55, D4 0.5, A4 0.45, E5 0.4 — more on the
thicker, wound low strings, which twist more freely relative to their transverse
impedance. All sit at the top of the useful range found above.

**Still simplified.** This is a broadband resistive loss gated to the slip
phase, not the frequency-dependent, travelling-and-reflecting torsional
waveguide of a real string. That richer model (or the thermal-friction and
finite-bow-width stabilisers below) is the route to a *larger* effect; this one
is the cheap, safe first cut the note anticipated.
## Finite bow-hair width — the "Hair" control (added later than the notes below)

Stabiliser #3 from "Why the model is more capture-prone" below, exposed as a
player control rather than forced on: the bow can contact the string over a
*ribbon of hair* instead of a mathematical point (`src/audio/dsp/StringSim.ts`
bow junction; `RibbonAverager` in `filters.ts`; the "Hair" slider in the HUD is
the bow's tilt, edge → flat). **It ships OFF (point contact = the original
model); flattening the hair is opt-in.** Why it's off by default is the
interesting part — see the trade below.

- **What it does.** The friction curve used to react to the string velocity at
  a single sample, `vh = bBow + cBow`. With hair width it reacts to that
  velocity *averaged over the contact patch*. Rounding the corner the friction
  *sees* spreads the moment of slip across the patch, which starves the brief
  secondary slip-within-a-period that captures the octave (double-slip).
- **Centre-weighted, not flat.** A real ribbon presses hardest at its middle, so
  the weighting is a **triangular** (Bartlett) window, not a boxcar —
  implemented as two cascaded boxcars (a triangle is the convolution of two
  rectangles), O(1) per sample. Versus a flat window of the same span the
  triangle rolls off the highs far more gently (no deep sinc notches), so it
  keeps much more of the bright sul-ponticello top. This mattered: a flat boxcar
  at the same width gutted the low strings' ponticello sizzle; the triangle
  roughly halves that loss.
- **Where the window comes from.** `bowHairWidth` is the ribbon width as a
  fraction of the OPEN-string length. The patch-crossing time is
  `w·(2L)/c = w·fs/(2·f0)` samples — constant per string regardless of stopping,
  because the patch and the wave speed are both fixed. That span is the
  triangle's base (`2L−1`); the boxcar half-length is `L`. With `bowHairWidth
  = 0` (`L = 1`) the average is a pass-through, `vhBar = vh`, and the junction is
  bit-for-bit the original point contact.
- **How it stays passive.** The friction force is computed from the patch-
  averaged relative velocity `vBow − vhBar` and applied to the *true* point
  velocity: `vJ = vh + (vJbar − vhBar)`, still bounded by the same friction
  curve — nothing added to the loop's energy budget.
- **The trade, and why it's off by default.** The suppression only becomes
  audible once the boxcar half-length reaches **4** (`w ≈ 0.05` on the G): at a
  firm stop two-thirds up the G, bowed over the fingerboard, a point contact
  locks the octave (2f holds ~0.69 of the f+2f energy, near deterministically)
  and half-length 4 pulls it back to ~0.4–0.55. But **half-length 4 is also
  where the costs bite**, all on the low strings whose window is widest:
  ponticello darkens, the attack softens, and — leaned on hard near the bridge —
  a low open string can tip into a surface whistle (the over-smoothed friction
  loses the fundamental's corner and locks a higher mode; the smoke test's
  mid-stroke G switch caught exactly this). Half-length 3 (`w ≲ 0.04`) is clean
  everywhere but barely suppresses. There is no single width that both suppresses
  well and leaves the low G untouched, so the default is point contact and the
  slider lets a player flatten the hair when they want the steadier, rounder
  sound and can live with the trade. `test/stringsim.test.ts` pins the mechanism
  at `w = 0.06` (point > 0.55, flattened at least 0.08 below).
- **Guardrail.** `MAX_HAIR_SAMPLES` caps the half-length at 4. Past 5 the
  over-smoothing becomes pathological on every string (a bright pseudo-flautando,
  ~0.99 octave), so no slider position, however far, can reach it.
- **Still the #3 stabiliser.** The model's attack choreography (see below)
  already lands Helmholtz on ordinary strokes, so there is little double-slip
  left to remove there; the gains show up in the octave-prone corners
  (flautando nodes, light fast bow), and the control is really as much a tone
  colour (edge = focused/bright, flat = round/steady) as a stabiliser.
## Sympathetic strings: the coupled bridge (added later than the notes below)

All four strings now run continuously as full waveguides terminated on ONE
bridge junction (`src/audio/dsp/ViolinSim.ts`); the worklet hosts the whole
instrument and `selectString` just moves the bow/finger. Design notes:

- **Two-way, physically derived coupling.** With velocity waves and Z = 1
  per string, a bridge of admittance Y_B gives v_B = Γ·Σv_k⁺ and reflections
  v_k⁻ = v_B − v_k⁺. Each string keeps its own termination filter (the
  (1−H_k) shortfall per bounce IS the energy the bridge takes), and the
  junction adds the cross-transmission γ·Σ_{j≠k} H_j(v_j⁺). γ = 0.0015:
  the receiving string's Q amplifies an on-coincidence drive by
  1/(1−ρ) ≈ 130–160, so the unison halo lands ~13% of the played note
  (−17.5 dB) — and the coupled loop-gain penalty, (N−1)·γ, keeps the system
  comfortably passive.
- **Pure-fifth tuning** (state.ts): open strings at exact 3:2 fifths from
  A440. In 12-EDO every cross-string coincidence is ~2 cents off — outside
  the receiving mode's half-power bandwidth (≈1/Q ≈ 7–10 cents), so
  coincidences beat instead of blooming. Pure fifths make them exact.
- **Tension-modulation recalibration** (StringSim.delayTargets). Measured
  bridge-wave amp² is ~0.11 for the gentlest sustained stroke and ~0.17–0.21
  driven hard; the old detune window (knee 0.012, cap 0.045) sat entirely
  below that, so EVERY bowed note carried the full detune — 9–20 cents sharp
  of nominal, which parked the played note off the open strings' resonances
  whenever the bow moved (sympathy only appeared after bow-off, weakly). The
  window is now knee 0.1, cap 0.3, scaled to preserve the old ceiling
  (nl × 0.033) for genuinely hard strokes. Side effect worth knowing:
  ordinary bowing is now in tune with the nominal pitch; pressing hard still
  pulls sharp — and audibly chokes the sympathy as it detunes, which is real.
- **Measurement method** (mirrors the attack-tuning method below): drive
  ViolinSim in Node, ramped attack, read each string's 30 ms bridge-wave
  envelope (`StringSim.amplitude()`) during the stroke and again ~0.3 s after
  bow-off — the bow's force noise puts a broadband forced floor (γ-scaled)
  on every sympathizer while bowing, but it dies within a few round trips of
  bow-off while resonantly accumulated energy rings on. Levels at γ=0.0015:
  stopped-E5-on-A unison rings the open E at 4.5–5× the semitone-detuned
  control (both during and after); a plucked open A rings the D (shared
  880 Hz partial) at ~16× the G's floor. `test/violinsim.test.ts` pins these.
- **Not modelled yet:** the unplayed strings are always open (a latched
  finger only stops the played string), and the bridge junction still
  reflects each string through its own filter rather than one true bridge
  admittance — a shared Y_B(ω) with the body's input impedance would be the
  next step toward wolf-note territory.

Working notes from tuning the keyboard-stroke attack (PR #12), kept here
because the measurements and the option space outlive that PR. The core
question: why does this model need a slower, more choreographed attack than
a real violin, and what would make it as responsive as the real thing?

## The problem

A bow attack does not automatically produce Helmholtz motion (the fundamental
stick–slip regime). Depending on how force and speed evolve over the first
tens of milliseconds, the string can instead capture:

- the **double-slip regime** — sounds an octave above;
- a **surface/whistle regime** — dominated by a higher partial (often the
  3rd), the bow skating over the string;
- **raucous** aperiodicity — force too high for the speed.

On a real instrument this is Guettler's territory: plotting bow force against
bow acceleration gives a wedge of "perfect attacks" that start Helmholtz
motion within a couple of string periods (5–20 ms). Players learn to land in
the wedge; attacks outside it scratch or whistle, on real strings just as
here. The difference is that **this model's wedge is much narrower** than a
real violin's — see "Why the model is more capture-prone" below.

## Measurements

Method: drive `StringSim` directly in Node (the same harness as `npm test`),
replicating the app's envelope exactly — including the 30 fps quantisation of
parameter updates — and classify the settled pitch 0.5–0.85 s into a stroke
by autocorrelation. 32–96 trials per configuration (the friction model has
force noise, so capture is stochastic). Three scenarios, in increasing order
of difficulty:

- **cold**: open-string attack from silence;
- **ring**: open-string attack while the string still rings from a previous
  stopped note;
- **land**: attack while the finger is still landing (pressure ramping in)
  on a ringing string.

Findings for a stroke reaching model speed 0.32 at force 0.45, contact 0.88
(A string), with a linear velocity ramp and a "bite" (extra force decaying
over 0.25 s from stroke start):

| ramp   | bite  | cold | ring | land | note |
|--------|-------|------|------|------|------|
| instant| none  | ~4%  |      |      | almost always wrong |
| 90 ms  | +40%  | ~80% | ~90% | ~30% | the original tuning |
| 200 ms | +40%  | ~98% | 100% | 100% | first fix: reliable but légato-soft |
| 80 ms  | +80%  | ~99% | ~93% | 100% | fast, occasional whistle |
| 50 ms  | +80%  | 100% | ~88% | ~30% | too fast for a landing finger |
| **150 ms** | **+80%** | **100%** | **~99%** | **100%** | **current keyboard tuning** |

The shape matters more than any single number: reliability depends on
*coordinating* force with acceleration (heavier bite ⇒ a faster ramp works),
which is exactly the Guettler wedge. Slower bow speed and higher steady
force were both tried and made capture *worse* — steady-state Schelleng
intuition does not describe attacks.

Related discovery: with a finger stopped a third of the way up the string and
the bow parked far from the bridge (contact ~0.75), attacks flip persistently
to the octave — that contact point is a third of the *speaking* length from
the bridge, genuine flautando territory. Real behaviour, worth knowing when
playing: if a stopped note whistles, bring the bow toward the bridge (`↓`).

Current tuning lives in `src/input/interactions.ts` (`KEY_ATTACK_S`,
`KEY_BITE_AMP` for keyboard strokes; pointer gestures and auto-bow keep the
original +40% bite).

## Why the model is more capture-prone than a real violin

Real strings have stabilisers this waveguide deliberately omits (see
"Notes & known limits" in the README). In rough order of impact on attack
reliability:

1. **Torsional waves.** The bow excites twist as well as transverse motion,
   and torsion is heavily damped — it acts as a loss channel *at the bow
   point* that absorbs the aperiodic junk during an attack. **Done** (see
   "Torsional loss at the bow" above): a simplified lossy torsional impedance,
   gated to the slip phase, closes the octave-flips at the hardest attack
   corner while leaving the stick-dominated extremes intact. It widens the
   wedge at the edge rather than "substantially" everywhere — a broadband
   resistive lump is cruder than real travelling torsional waves — but it was
   the highest-value upgrade and it landed cleanly.
2. **Thermal (plastic) friction.** The model uses the classic
   velocity-dependent hyperbolic friction curve, which is known to
   exaggerate spurious regimes; rosin actually behaves thermally
   (Smith & Woodhouse), with hysteresis that stabilises attacks.
3. **Finite bow-hair width.** A ribbon of hair rather than a point contact
   averages slip timing across the contact patch and suppresses double-slip.
   *Implemented as the opt-in "Hair" control* — see "Finite bow-hair width" at
   the top. The lowest-impact of the three, as ranked: it trims the octave-prone
   corners but leaves ordinary strokes (already choreographed into Helmholtz)
   untouched, and its useful strength coincides with where it starts costing the
   low strings — so it ships off, as bow tilt the player dials in.

## Cheaper options, short of new physics

- **Pitch-scaled attack**: make the ramp a fixed number of *periods*
  (~40) rather than milliseconds. High stops then attack in tens of
  milliseconds automatically, and the slowness concentrates on the low G
  where it is least audible.
- **Regime assist**: the worklet knows the expected period and the slip
  cadence, so a wrong capture is detectable within a couple of periods; a
  brief force nudge then knocks the string back to the fundamental. An
  invisible "autocorrect" — unphysical, very effective, best as a toggle so
  purists can turn it off.
- **Articulation control**: expose the trade to the player instead of hiding
  it — e.g. a double-tap arrow for a martelé attack (short ramp, heavy bite,
  real whistle risk), keeping the safe envelope for ordinary strokes.
