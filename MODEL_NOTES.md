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

### The torsional reduction is low-passed (fix: the metallic comb)

The original shunt applied its scaling *instantaneously*: the slip branch's
excursion was `(ad − s)·torsFrac` while the stick branch was untouched, so the
friction force **stepped** by `(1 − torsFrac)·k·muS` at every slip onset and
release — twice per Helmholtz period. A periodic step train is a bright
harmonic comb, and it was audible: a metallic, glassy buzz ("playing on the
metal winding") riding on a correctly locked note. Measured with the held-note
probe in `test/bowNoiseHarness.test.ts`: the 2.5–8 kHz content of a locked
note is 97–99% *harmonic* (a comb on f0, not noise), and at a slow, heavy
stroke (open G, vel 0.05, force 0.6) the instantaneous shunt made the regime
**bistable** — most strokes settled at ~15–19% high-comb energy vs a tight
~3.5% with torsion off; the shipped torsional+thermal combination landed in
the buzzy state on a minority of strokes (clean median, upper quartile ~18%).
Touch bowing lives near that corner (slow, heavy relative to speed, each
stroke re-rolling the stochastic dice), and small phone speakers emphasise
exactly that band while dropping the fundamentals — which is why it presented
as "many high-pitched harmonicy noises, much worse on mobile".

The fix: the reduction the shunt applies is now a **one-pole state**
(`torsRed`, time constant `TORS_TAU_S` = 0.2 ms ≈ 10 samples at 48 kHz) that
relaxes toward `(1 − torsFrac)·excursion` during slip and toward 0 in
stick/silence, and is subtracted from the junction velocity wherever it
stands. A sustained slip converges to the same shunted junction as before
(the loss — and the wedge-widening — is preserved); the stick/slip boundaries
now ramp over ~10 samples instead of stepping, which removes the comb's
content in the audible 2.5–8 kHz band. Physically: the twist that soaks up a
slip is a wave leaving the contact, not an instantaneous sink. `torsional = 0`
keeps `torsRed` identically 0 and the junction bit-for-bit unchanged.

Measured after the fix (same probes): the bistable buzzy state is gone — the
shipped combination is the *tightest* variant at the slow-heavy corner (median
0.62%, IQR 0.61–0.66%) and unchanged at ordinary strokes; the attack corners
hold or improve (torsional "land" corner 98–100% capture at all amounts; the
thermal octave corner with full torsional layered on rises 90% → 98%); the
stopped-unison sympathetic ring is a comfortable ~4.1–4.2× the detuned
control (the old instantaneous shunt's buzz had been artificially feeding the
coincidence partials at ~4.5–5×; a naive boundary-matched form without the
loss dropped it to a marginal ~2.9×). All existing pinned tests pass
unchanged.

One instructive dead end, for the record: matching the slip branch to the
stick boundary *instantaneously* (`k·muS + (ad − s − k·muS)·torsFrac`) also
removes the comb, but it **raises** the friction force during slip toward the
stick value instead of dissipating — the wedge collapses (the octave corner
fell from 90% to 0% capture). Continuity had to come from the reduction's
*time constant*, not from re-anchoring its magnitude.

### Bow-speed gate (applies to both the torsional and thermal wedge)

Both the torsional slip-loss and the thermal softening widen the Helmholtz
*capture* region — that is precisely what makes an attack lock the fundamental.
But a wider capture region is only wanted for a bow drawn **across** the string.
When the bow is instead dragged **along** the string (a vertical drag over the
fingerboard, near-zero transverse motion), the only transverse velocity the
model sees is the pointer's residual lateral jitter — and a widened wedge lets
that jitter capture the string into a spurious, sustained, over-loud pitched
tone. On a real instrument a bow moving only along the string does not sound the
string at all (you hear the hair vibrating, not the string). Measured on the low
G, the two effects roughly *doubled* the string's output at jitter-level bow
speeds (`|vBow|` ≈ 0.002–0.01) versus with them off — audibly "activating" the
string during a vertical drag.

Fix: gate both effects by transverse bow speed. A `wedge` factor ramps from 0
below `WEDGE_V0` (0.005) to 1 at `WEDGE_V1` (0.02) — the torsional transverse
fraction fades back toward 1 (no twist loss) and the thermal `β` toward 0 (no
softening) as it closes, so a near-stationary transverse contact reverts to the
plain velocity curve while any genuine stroke keeps the full wedge. The window
sits far under real playing speeds (~0.05–0.3, slow bows included) yet above
jitter, so sustained tone, attacks (the ramp crosses `WEDGE_V1` almost at once)
and the slow-bow/over-pressure extremes are untouched. Because the gate only
scales the torsional/thermal *deviations* — both zero when their amounts are zero
— the `torsional = 0` / `thermal = 0` paths stay byte-for-byte the classic curve.

## Thermal (plastic) friction (added later than the notes below)

Implements the second item under "Why the model is more capture-prone" below:
the friction coefficients are modulated by a lumped contact temperature instead
of held constant. It lives in the same bow stick–slip solver
(`src/audio/dsp/StringSim.ts`, `tickComplete`), with a per-string `thermal`
amount in `StringSpec` (default 0 = off) set in `state.ts`.

**The physics, and the one design choice that matters.** Real rosin friction is
set by contact *temperature*, not sliding speed (Smith & Woodhouse 2000): the
contact flash-heats while the string slips, the rosin softens and the friction
drops — then recovers as the contact cools between slips. Crucially the heat
*lags* the sliding by the flash-contact time constant, so the coefficient the
curve uses this sample depends on the recent slip history, not the instantaneous
velocity: the friction curve opens into a hysteresis loop. That lag is what
damps the runaway the plain velocity curve is prone to, so it stabilises attacks
and widens the Helmholtz regime. The cheap lumped model (cf. the torsional
note): one scalar contact temperature `T` per string, a first-order state like a
`Smoother`. Heating during slip is the frictional power `T += kHeat·fFric·|vSlip|`
(both measured in the patch-averaged sense the stick/slip decision uses, so it
composes with the bow-hair ribbon); cooling every sample is `T -= T/tauCool`,
with `tauCool` the flash time (~0.4 ms, ~19 samples at 48 kHz — that short lag
*is* the hysteresis). The coefficient is softened by `θ(T) = 1/(1 + β·T)`, `β`
scaled by the per-string `thermal` amount so it is a no-op at 0 and monotone
above it.

The choice that matters: **θ softens only the DYNAMIC coefficient `muD` (the slip
branch), NOT the static stick threshold `muS`.** The recommended first cut
softens both. But softening `muS` lowers the stick threshold, which lets a
*working* Helmholtz break into slip too readily — and it shows up as a
non-monotone capture hole (a settled stopped note that flips out and back as
`thermal` rises) and a measurable loss of ponticello brightness. Softening only
the slip branch leaves the stick threshold — and with it every stick-dominated
regime — exactly where it was, and widens the attack wedge cleanly. This is the
same move as the torsional note's "act only in the slip branch", for the same
reason: the attack transient is slip-heavy, the sustained regimes are
stick-heavy, and the thermal benefit concentrates in the transient.

**What it does, measured** (same harness method as the torsional note: drive
`StringSim` in Node, classify settled pitch by autocorrelation over many
stochastic strokes):

- *Widens the attack wedge, monotonically.* At a genuinely octave-prone corner —
  a high stop (node ~0.7) on the G bowed over the fingerboard, fast ramp, finger
  still landing — the classic velocity curve locks the octave essentially every
  time (~0% fundamental capture). Thermal pulls it up monotonically to 100% and
  holds it across `thermal` ≈ 0.2–0.5, degrading only past ~0.6 as too much
  softening starves the slip. The chosen amounts sit mid-plateau. Corners the
  attack choreography already lands were reliable anyway, so there the change is
  neutral — the win is at the edge.
- *Opens the hysteresis loop.* Plotting the transverse friction force against the
  bow-string sliding velocity over a Helmholtz cycle: with the classic curve the
  trajectory retraces a single-valued curve (near-zero enclosed area — only
  force-noise scatter); with thermal the slip branch traces a genuine loop, ~7×
  the area. `test/stringsim.test.ts` pins the loop opening and the wedge.
- *Tames the flat-hair pressure whistle.* The heavy, near-bridge low-G stroke
  that whistles ~100% of the time with the hair laid flat and the classic curve
  holds the fundamental ~100% of the time with thermal engaged — see the hair
  section, whose forward reference this confirms.
- *Extremes preserved.* Over-pressure still crunches, a slow bow still speaks (a
  hair louder, if anything), sul ponticello stays ≫ sul tasto, and the
  extreme-tasto subharmonic survives intact. Ponticello brightness on the high
  strings is unchanged (measured).

**Chosen amounts** (`state.ts`): G3 0.4, D4 0.35, A4 0.3, E5 0.25 — graded down
like the torsional shunt. The win concentrates on the low strings, where the
hardest attacks (and the flat-hair whistle) live; the high strings are already
reliable on ordinary attacks and carry a smaller amount that leaves their tone
untouched.

**Still simplified.** The true contact temperature comes from 1-D heat diffusion
into the string and the rosin, which gives a *half-order* (`~1/√t`) memory kernel
— a long, slowly-decaying tail, not the single exponential pole used here. The
lumped one-pole `T` captures the essential lag (heat trails the slip) at O(1) per
sample; the faithful version would swap the pole for that fractional kernel —
heavier, a truer temperature history, and the route to a still-larger and more
accurate effect. As with torsion, this is the cheap, safe first cut the note
anticipated.

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
- **Reconciled with thermal friction (now shipped).** The pressure whistle above
  was the *hard* cost — the one that made flat hair genuinely risky rather than
  merely a tone change. Thermal friction (added since; per-string, always on)
  resists exactly that spurious high-mode lock, and it is measurably gone: the
  heavy near-bridge low-G stroke that whistles ~100% of the time with flat hair
  and the classic curve holds the fundamental ~100% of the time with thermal
  engaged (pinned in `test/stringsim.test.ts`). So the forward reference this
  section used to carry is confirmed — with thermal in, the pressure whistle is
  tamed and the width feature is no longer *needed* as a stabiliser. It stays off
  by default now for the softer reasons: the remaining costs are pure tone
  (ponticello darkens, the attack softens at half-length 4), and its
  double-slip-suppression job is largely covered by thermal and the torsional
  shunt. The `MAX_HAIR_SAMPLES` cap stays put regardless: the half-length-5
  pseudo-flautando it guards against is an *averaging* artifact (the window
  rounding the fundamental's own corner away), not a friction one, so thermal
  does not touch it.
- **Guardrail.** `MAX_HAIR_SAMPLES` caps the half-length at 4. Past 5 the
  over-smoothing becomes pathological on every string (a bright pseudo-flautando,
  ~0.99 octave), so no slider position, however far, can reach it.
- **Still the #3 stabiliser — now more tone than stabiliser.** The model's attack
  choreography (see below) already lands Helmholtz on ordinary strokes, so there
  is little double-slip left to remove there; the gains show up in the
  octave-prone corners (flautando nodes, light fast bow) — and those are now
  handled by thermal friction, which widens the same wedge without the ponticello
  cost. So with thermal shipped the Hair control is really a tone colour
  (edge = focused/bright, flat = round/steady) that a player dials in, more than a
  stabiliser the model relies on.
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
2. **Thermal (plastic) friction.** The classic velocity-dependent
   hyperbolic friction curve is known to exaggerate spurious regimes;
   rosin actually behaves thermally (Smith & Woodhouse), with a
   hysteresis that stabilises attacks. **Done** (see "Thermal (plastic)
   friction" above): the contact temperature is a lumped first-order
   state that softens the dynamic friction coefficient, gated — like the
   torsional loss — to the slip branch. It widens the attack wedge
   monotonically at the hardest low-string corners, closing octave-flips
   the velocity curve locks in, and as a bonus tames the finite-hair
   pressure whistle, so that stabiliser is no longer needed for it.
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
