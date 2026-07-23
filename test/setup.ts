import { afterEach, beforeEach } from "vitest";

/**
 * Deterministic randomness for the unit suite.
 *
 * The bow model injects a little force noise via `Math.random()`
 * (`StringSim` — the bow's breathy texture), so a couple of the tolerance
 * assertions on bowed spectra were sensitive to which noise realization a run
 * happened to draw. Left unseeded that made ~10-20% of full-suite runs fail on
 * the double-slip / shunt-level bounds — pure CI flake, not a real regression.
 *
 * We pin `Math.random` to a fixed LCG stream (reset before every test, restored
 * after) so each test always sees the same noise sequence and results are
 * reproducible. This is the same generator the two bit-exact tests already
 * install locally; here it simply covers the whole suite. Tests that need their
 * own seeded stream still save/restore `Math.random` themselves and keep working.
 */
const SEED = 0x2545f4b7;

function seededRandom(seed: number): () => number {
  let s = seed & 0x7fffffff;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const original = Math.random;

beforeEach(() => {
  Math.random = seededRandom(SEED);
});

afterEach(() => {
  Math.random = original;
});
