/**
 * Light "magnetic" snapping of the stopping finger onto a scale, or (in Touch
 * mode) onto the natural-harmonic nodes. The snap is a continuous, monotonic
 * remap of the finger position: exactly on a scale degree it locks in, at the
 * edge of a degree's capture window it leaves the finger untouched, and in
 * between it pulls progressively harder the closer the finger gets — so
 * glissandi still sweep the whole string, they just linger on the notes.
 *
 * Scales are rooted on the OPEN STRING (each string gets its own major scale,
 * etc.), and — this being a violin — the major and minor scales are tuned in
 * quarter-comma meantone relative to that root (pure 5/4 major thirds, fifths
 * tempered by a quarter of the syntonic comma), while the chromatic scale is
 * plain 12-EDO, where meantone's split into unequal semitones would just fight
 * the tuner readout.
 */
import { state, FINGER_RADIUS, MAX_STOP_NODE, FINGERBOARD_END, SnapMode } from "../state";

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
export function scaleCents(mode: Exclude<SnapMode, "off">): number[] {
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

const scaleTargetCache = new Map<SnapMode, number[]>();

/** All snap targets (fingertip centres, sorted ascending) for a scale mode,
 * repeated up the octaves as far as the string can be stopped. Includes the
 * unison — a finger drifting close to the nut is pulled onto the open string. */
export function scaleTargets(mode: Exclude<SnapMode, "off">): number[] {
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

let nodeTargetCache: number[] | null = null;

/** Snap targets for Touch mode: the natural-harmonic nodes k/n (n = 2..6, the
 * same set the node markers draw), as fingertip centres. The acoustic touch
 * point sits a FINGER_RADIUS bridge-ward of the centre, so these too aim the
 * centre a radius short of the node — the flageolet then speaks dead on. */
export function nodeTargets(): number[] {
  if (nodeTargetCache) return nodeTargetCache;
  const nodes = new Set<number>();
  for (let n = 2; n <= 6; n++) {
    for (let k = 1; k < n; k++) {
      if (gcd(k, n) === 1) nodes.add(k / n);
    }
  }
  nodeTargetCache = [...nodes]
    .filter((p) => p <= FINGERBOARD_END)
    .sort((a, b) => a - b)
    .map((p) => p - FINGER_RADIUS);
  return nodeTargetCache;
}

// Widest capture window to either side of a target (fraction of the string).
// Near the nut a meantone whole tone spans ~0.105 of the string, so an
// uncapped half-way window would snap almost everything; capping it leaves a
// free-glide stretch between low notes while high positions — where the notes
// crowd closer than the cap — hand over seamlessly at the midpoints.
const SNAP_WINDOW_MAX = 0.045;
// Residual curve inside the window: offset' = offset·(|offset|/window)^EASE.
// Continuous at the window edge (offset' = offset), zero at the target, and
// in between the finger keeps ~this fraction of its distance — light enough
// to slide through, firm enough that landing near a note lands ON it.
const SNAP_EASE = 2;

/** Remap a fingertip-centre position by the light snap toward the nearest of
 * `targets` (sorted ascending). Positions outside every capture window pass
 * through unchanged. */
export function snapPosition(p: number, targets: number[]): number {
  if (targets.length === 0) return p;
  // nearest target (they're sorted; the list is small, so scan)
  let i = 0;
  for (let j = 1; j < targets.length; j++) {
    if (Math.abs(targets[j] - p) < Math.abs(targets[i] - p)) i = j;
  }
  const t = targets[i];
  const d = p - t;
  // window: to the halfway point toward the neighbour on this side, capped
  const nb = d >= 0 ? targets[i + 1] : targets[i - 1];
  const w = Math.min(SNAP_WINDOW_MAX, nb === undefined ? Infinity : Math.abs(nb - t) / 2);
  if (w <= 0 || Math.abs(d) >= w) return p;
  return t + d * Math.pow(Math.abs(d) / w, SNAP_EASE);
}

/** The snap in force for the current left-hand mode: scale snapping under a
 * pressed finger, node snapping for a harmonic touch (each with its own
 * setting), or the identity when the relevant setting is off. */
export function snapFinger(p: number): number {
  if (state.leftMode === "touch") {
    return state.snapNodes ? snapPosition(p, nodeTargets()) : p;
  }
  return state.snap === "off" ? p : snapPosition(p, scaleTargets(state.snap));
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
