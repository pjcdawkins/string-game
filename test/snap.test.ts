import { describe, it, expect } from "vitest";
import {
  MEANTONE_FIFTH_CENTS,
  scaleCents,
  scaleTargets,
  guidePositions,
} from "../src/guides";
import { nodeTargets, snapPosition } from "../src/input/snap";
import { FINGER_RADIUS, FINGERBOARD_END, MAX_STOP_NODE, state } from "../src/state";

/** Cents above the open string sounded by a fingertip centred at `p`. */
function centerToCents(p: number): number {
  return -1200 * Math.log2(1 - (p + FINGER_RADIUS));
}

describe("guide scales", () => {
  it("shows chromatic guides, snapped to — and onto nodes in Touch mode — out of the box", () => {
    expect(state.guides).toBe("chromatic");
    expect(state.snap).toBe(true);
    expect(state.snapNodes).toBe(true);
  });

  it("tempers the meantone fifth by a quarter comma", () => {
    // a pure 3/2 is ~701.955¢; quarter-comma meantone flattens it ~5.38¢
    expect(MEANTONE_FIFTH_CENTS).toBeCloseTo(696.578, 2);
  });

  it("builds the meantone major scale with a pure 5/4 third", () => {
    const c = scaleCents("major");
    expect(c).toHaveLength(7);
    expect(c[0]).toBe(0);
    expect(c[1]).toBeCloseTo(193.157, 2); // whole tone = half the pure third
    expect(c[2]).toBeCloseTo(1200 * Math.log2(5 / 4), 6); // pure major third
    expect(c[4]).toBeCloseTo(MEANTONE_FIFTH_CENTS, 6);
  });

  it("builds the meantone natural minor with a pure 8/5 sixth", () => {
    const c = scaleCents("minor");
    expect(c).toHaveLength(7);
    expect(c[2]).toBeCloseTo(310.265, 2); // meantone minor third
    expect(c[5]).toBeCloseTo(1200 * Math.log2(8 / 5), 6); // pure minor sixth
  });

  it("builds the chromatic scale in 12-EDO", () => {
    expect(scaleCents("chromatic")).toEqual(
      Array.from({ length: 12 }, (_, i) => i * 100)
    );
  });

  it("lays targets up the octaves, in range, ending before the stop ceiling", () => {
    for (const mode of ["major", "minor", "chromatic"] as const) {
      const t = scaleTargets(mode);
      expect(t[0]).toBeCloseTo(-FINGER_RADIUS, 9); // unison = open string
      for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
      // every target's acoustic stop stays on the string
      expect(t[t.length - 1] + FINGER_RADIUS).toBeLessThanOrEqual(MAX_STOP_NODE);
      // spans at least 3 octaves of playable range
      expect(centerToCents(t[t.length - 1])).toBeGreaterThan(3600);
      // an octave above the open string is a degree of every scale
      const octave = t.map(centerToCents).map((c) => Math.abs(c - 1200));
      expect(Math.min(...octave)).toBeLessThan(1e-6);
    }
  });

  it("rules each guide line right on its snap target (the fingertip centre), on the board only", () => {
    for (const mode of ["major", "minor", "chromatic"] as const) {
      const g = guidePositions(mode);
      const targets = scaleTargets(mode);
      // no line at the nut (the unison), ascending, none past the board's end
      expect(g[0]).toBeGreaterThan(0.02);
      for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThan(g[i - 1]);
      expect(g[g.length - 1]).toBeLessThanOrEqual(FINGERBOARD_END);
      // a guide IS a snap target: a snapped finger centres dead on its line…
      for (const p of g) expect(targets).toContain(p);
      // …and every on-board target (bar the sub-nut unison) gets its guide
      expect(g).toEqual(targets.filter((t) => t > 0 && t <= FINGERBOARD_END));
      // the line sits a finger radius nut-ward of where the note speaks
      expect(centerToCents(g[0])).toBeCloseTo(mode === "chromatic" ? 100 : scaleCents(mode)[1], 6);
    }
  });

  it("aims the touch targets dead on the nodes (a light touch damps under the finger's middle)", () => {
    const t = nodeTargets();
    // lowest node is the 1/8 flageolet, highest the 7/8
    expect(t[0]).toBeCloseTo(1 / 8, 9);
    expect(t[t.length - 1]).toBeCloseTo(7 / 8, 9);
    expect(t).toContain(0.5);
  });
});

describe("snapPosition", () => {
  const targets = scaleTargets("major");

  it("is exact on a target and identity outside every window", () => {
    for (const t of targets) expect(snapPosition(t, targets)).toBe(t);
    // dead middle of the low whole tone (gap ~0.105 > 2×window cap): free
    const mid = (targets[0] + targets[1]) / 2;
    expect(snapPosition(mid, targets)).toBe(mid);
  });

  it("pulls toward the nearest target inside the window", () => {
    const t = targets[2]; // the major third
    const p = t + 0.01;
    const snapped = snapPosition(p, targets);
    expect(snapped).toBeGreaterThan(t);
    expect(snapped).toBeLessThan(p); // pulled back toward the note
  });

  it("remaps monotonically and continuously (glissandi survive)", () => {
    let prev = -Infinity;
    let prevOut = -Infinity;
    for (let p = -0.02; p < 0.9; p += 0.0005) {
      const out = snapPosition(p, targets);
      expect(out).toBeGreaterThanOrEqual(prevOut);
      // no jumps bigger than the input step + a hair
      if (prev !== -Infinity) expect(out - prevOut).toBeLessThan(0.004);
      prev = p;
      prevOut = out;
    }
  });
});
