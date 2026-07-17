# Model notes: bow-attack reliability, and where to take the model next

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
   point* that absorbs the aperiodic junk during an attack. Adding even a
   simplified lossy torsional impedance at the bow junction should widen the
   attack wedge substantially. Highest-value upgrade if the goal is
   real-violin responsiveness.
2. **Thermal (plastic) friction.** The model uses the classic
   velocity-dependent hyperbolic friction curve, which is known to
   exaggerate spurious regimes; rosin actually behaves thermally
   (Smith & Woodhouse), with hysteresis that stabilises attacks.
3. **Finite bow-hair width.** A ribbon of hair rather than a point contact
   averages slip timing across the contact patch and suppresses double-slip.

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
