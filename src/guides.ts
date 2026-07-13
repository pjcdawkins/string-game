/**
 * The guide scales: one scale, rooted on the OPEN STRING, shared by the
 * fingerboard guide lines (scene/scene.ts) and the pressed-finger snap
 * targets (input/snap.ts) so the two can never drift apart — a drawn guide
 * and the position the finger snaps onto are by construction the same
 * degree. (The same pattern as harmonics.ts for the Touch-mode nodes.)
 *
 * This being a violin, the major and minor scales are tuned in quarter-comma
 * meantone relative to that root (pure 5/4 major thirds, fifths tempered by
 * a quarter of the syntonic comma), while the chromatic scale is plain
 * 12-EDO, where meantone's split into unequal semitones would just fight the
 * tuner readout.
 */
import { FINGER_RADIUS, FINGERBOARD_END, MAX_STOP_NODE, GuideMode } from "./state";

/** Quarter-comma meantone fifth: four of them stack to a pure 5/4 double
 * octave, so one fifth is 5^(1/4), i.e. (1200/4)·log2(5) cents ≈ 696.58. */
export const MEANTONE_FIFTH_CENTS = 300 * Math.log2(5);

// Scale degrees as positions on the chain of fifths relative to the tonic
// (the open string): each entry is how many tempered fifths up (+) or down (−)
// the degree sits, reduced into one octave. Ionian spans F..B (−1..+5);
// natural minor (aeolian) spans the chain shifted three fifths flatward.
const MAJOR_CHAIN = [0, 2, 4, -1, 1, 3, 5]; // do re mi fa sol la ti
const MINOR_CHAIN = [0, 2, -3, -1, 1, -4, -2]; // do re me fa sol le te

/** One octave of scale degrees in cents above the open string, sorted. */
export function scaleCents(mode: Exclude<GuideMode, "off">): number[] {
  if (mode === "chromatic") return Array.from({ length: 12 }, (_, i) => i * 100);
  const chain = mode === "major" ? MAJOR_CHAIN : MINOR_CHAIN;
  return chain
    .map((k) => (((k * MEANTONE_FIFTH_CENTS) % 1200) + 1200) % 1200)
    .sort((a, b) => a - b);
}

/** Fingertip-centre position (fraction from the nut) sounding `cents` above
 * the open string: the acoustic stop sits one FINGER_RADIUS bridge-ward of the
 * centre (see fingerStop in state.ts), so aim the centre a radius short. */
function centsToCenter(cents: number): number {
  return 1 - Math.pow(2, -cents / 1200) - FINGER_RADIUS;
}

const scaleTargetCache = new Map<GuideMode, number[]>();

/** All snap targets (fingertip centres, sorted ascending) for a guide scale,
 * repeated up the octaves as far as the string can be stopped. Includes the
 * unison — a finger drifting close to the nut is pulled onto the open string. */
export function scaleTargets(mode: Exclude<GuideMode, "off">): number[] {
  let t = scaleTargetCache.get(mode);
  if (t) return t;
  const degrees = scaleCents(mode);
  t = [];
  for (let octave = 0; ; octave++) {
    const base = octave * 1200;
    let clipped = false;
    for (const c of degrees) {
      const stop = 1 - Math.pow(2, -(base + c) / 1200);
      if (stop > MAX_STOP_NODE) {
        clipped = true;
        break;
      }
      t.push(centsToCenter(base + c));
    }
    if (clipped) break;
  }
  scaleTargetCache.set(mode, t);
  return t;
}

/** Positions (fractions from the nut, ascending) of the guide lines drawn
 * across the fingerboard: one line per scale degree, like a learner's finger
 * tapes. A violinist centres the fingertip on the tape, so each line marks
 * where the *middle of the finger* goes — one FINGER_RADIUS nut-ward of the
 * degree's acoustic stop (the patch's bridge-side edge, where the note
 * speaks). That is exactly the snap targets, so a snapped finger sits
 * dead-centre on its line: the guides ARE the on-board targets, with the
 * unison dropped (the nut itself marks the open string) and — unlike the
 * snap, which carries on to MAX_STOP_NODE — clipped at the board's end. */
export function guidePositions(mode: Exclude<GuideMode, "off">): number[] {
  return scaleTargets(mode).filter((t) => t > 0 && t <= FINGERBOARD_END);
}
