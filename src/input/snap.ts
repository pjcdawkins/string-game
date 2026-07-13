/**
 * Light "magnetic" snapping of the stopping finger onto the fingerboard
 * guides' scale, or (in Touch mode) onto the natural-harmonic nodes. The snap
 * is a continuous, monotonic remap of the finger position: exactly on a scale
 * degree it locks in, at the edge of a degree's capture window it leaves the
 * finger untouched, and in between it pulls progressively harder the closer
 * the finger gets — so glissandi still sweep the whole string, they just
 * linger on the notes.
 *
 * The scale itself (rooted on the open string; meantone major/minor, 12-EDO
 * chromatic) lives in ../guides.ts, shared with the drawn guide lines so a
 * guide and its snap target can never drift apart. The snap does outrun the
 * guides, though: they stop at the fingerboard's end, while the snap targets
 * carry on as far as the string can be stopped.
 */
import { state } from "../state";
import { scaleTargets } from "../guides";
import { HARMONIC_NODES } from "../harmonics";

/** Snap targets for Touch mode: the natural-harmonic nodes (HARMONIC_NODES —
 * the very set the node markers draw), as fingertip centres, over the whole
 * string from the nut toward the bridge. A light touch damps the string
 * under the *middle* of the finger (unlike a firm press, which stops it at
 * the patch's bridge-side edge), so the centre aims dead on the node — a
 * finger snapped onto a marker dot sounds its flageolet. */
const NODE_TARGETS = HARMONIC_NODES.map(({ p }) => p);

export function nodeTargets(): number[] {
  return NODE_TARGETS;
}

// Widest capture window to either side of a target (fraction of the string).
// Near the nut a meantone whole tone spans ~0.105 of the string, so an
// uncapped half-way window would snap almost everything; capping it leaves a
// free-glide stretch between low notes while high positions — where the notes
// crowd closer than the cap — hand over seamlessly at the midpoints.
const SNAP_WINDOW_MAX = 0.0495;
// Residual curve inside the window: offset' = offset·(|offset|/window)^EASE.
// Continuous at the window edge (offset' = offset), zero at the target, and
// in between the finger keeps ~this fraction of its distance — light enough
// to slide through, firm enough that landing near a note lands ON it.
// (Both constants were tuned ~10% stickier after play-testing: the window cap
// up from 0.045 widens the magnet's reach in the low positions where the cap
// governs, and the ease up from 2 deepens the in-window pull everywhere,
// including the high positions whose windows the note midpoints limit.)
const SNAP_EASE = 2.2;

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

/** The snap in force for the current left-hand mode: guide snapping under a
 * pressed finger, node snapping for a harmonic touch (each with its own
 * setting), or the identity when the relevant setting is off — including
 * when there are no guides to snap to. */
export function snapFinger(p: number): number {
  if (state.leftMode === "touch") {
    return state.snapNodes ? snapPosition(p, nodeTargets()) : p;
  }
  return state.snap && state.guides !== "off"
    ? snapPosition(p, scaleTargets(state.guides))
    : p;
}
