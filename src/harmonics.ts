/**
 * The natural-harmonic node set, shared by the scene's node markers
 * (scene/scene.ts) and the Touch-mode snap targets (input/snap.ts) so the
 * two can never drift apart: a marker dot and the position the finger snaps
 * to are by construction the same node.
 *
 * Nodes are the interior points k/n (n = 2..8, k coprime to n — a shared
 * factor would repeat a lower harmonic's node) of the vibrating string, i.e.
 * fractions of nut→bridge for an open string, and of stop→bridge when the
 * markers are drawn relative to a firm stop. The set spans the WHOLE
 * vibrating string, right down toward the bridge — the string can be touched
 * past the fingerboard's end, as it can on a real violin, so the mirrored
 * upper nodes (¾, ⅘, ⅚ …) are as playable as their nut-side twins.
 */
export interface HarmonicNode {
  /** Node position as a fraction of the vibrating length. */
  p: number;
  /** Lowest harmonic number sounding from a touch there. */
  n: number;
}

export const HARMONIC_NODES: readonly HarmonicNode[] = (() => {
  const byPos = new Map<number, number>(); // position -> lowest harmonic number
  for (let n = 2; n <= 8; n++) {
    for (let k = 1; k < n; k++) {
      if (gcd(k, n) !== 1) continue;
      const p = k / n;
      if (!byPos.has(p)) byPos.set(p, n);
    }
  }
  return [...byPos.entries()]
    .sort(([a], [b]) => a - b)
    .map(([p, n]) => ({ p, n }));
})();

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
