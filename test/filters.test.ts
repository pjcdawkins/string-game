import { describe, expect, it } from "vitest";
import { RibbonAverager } from "../src/audio/dsp/filters";

describe("RibbonAverager", () => {
  it("half-length 1 is a pass-through (point contact)", () => {
    const r = new RibbonAverager(4);
    r.setHalfLength(1);
    for (const x of [0.3, -0.7, 0.1, 0.9]) expect(r.process(x)).toBeCloseTo(x, 12);
  });

  it("changes window length click-free mid-signal", () => {
    // Regression: dragging the Hair slider mid-stroke crosses integer span
    // thresholds, changing the window every block. Zeroing the running sums on
    // a change made the average collapse toward 0 for ~2L samples — an audible
    // click in the feature's advertised use. Re-seeding keeps it continuous.
    const r = new RibbonAverager(4);
    r.setHalfLength(2);
    let last = 0;
    for (let i = 0; i < 50; i++) last = r.process(0.5);
    expect(last).toBeCloseTo(0.5, 9);
    r.setHalfLength(4); // change mid-signal
    for (let i = 0; i < 12; i++) expect(r.process(0.5)).toBeCloseTo(0.5, 9);
  });
});
