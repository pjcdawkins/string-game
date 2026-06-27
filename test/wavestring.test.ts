import { describe, it, expect } from "vitest";
import { WaveString } from "../src/scene/waveString";

/** Snapshot the whole displacement profile. */
function profile(w: WaveString): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.n; i++) out.push(w.displacement(i));
  return out;
}

const LOSSLESS = { loss: 1, hfLoss: 0 };

/** Advance one sample at a time — the renderer takes ~25 steps per frame, so a
 * single huge advance() never happens (and would hit the anti-spiral cap). */
function run(w: WaveString, steps: number, opts = LOSSLESS): void {
  for (let s = 0; s < steps; s++) w.advance(1, opts);
}

describe("WaveString waveguide", () => {
  it("keeps both fixed ends as nodes", () => {
    const w = new WaveString(64);
    w.pluck(0.3, 1);
    for (let s = 0; s < 200; s++) {
      w.advance(1, LOSSLESS);
      expect(Math.abs(w.displacement(0))).toBeLessThan(1e-6);
      expect(Math.abs(w.displacement(w.n - 1))).toBeLessThan(1e-6);
    }
  });

  it("keeps both fixed ends as nodes under production-like loss", () => {
    // loss must be distributed so the rails stay equal-and-opposite at the ends;
    // applying it only to the reflected rail would let the node drift by ~(1-loss).
    const w = new WaveString(64);
    w.pluck(0.3, 1);
    for (let s = 0; s < 200; s++) {
      w.advance(1, { loss: 0.86, hfLoss: 0.12 });
      expect(Math.abs(w.displacement(0))).toBeLessThan(1e-9);
      expect(Math.abs(w.displacement(w.n - 1))).toBeLessThan(1e-9);
    }
  });

  it("is periodic over one round trip (2·segmentLength) when lossless", () => {
    const w = new WaveString(48);
    w.pluck(0.4, 1);
    const start = profile(w);
    run(w, 2 * w.segmentLength);
    const after = profile(w);
    for (let i = 0; i < w.n; i++) expect(after[i]).toBeCloseTo(start[i], 5);
  });

  it("conserves energy without loss", () => {
    const w = new WaveString(80);
    w.pluck(0.25, 1);
    const e0 = w.energy();
    run(w, 500);
    expect(w.energy()).toBeCloseTo(e0, 5);
  });

  it("decays the ring-down when lossy", () => {
    const w = new WaveString(80);
    w.pluck(0.25, 1);
    const e0 = w.energy();
    run(w, 1000, { loss: 0.95, hfLoss: 0.1 });
    expect(w.energy()).toBeLessThan(e0 * 0.5);
  });

  it("confines vibration to the bridge side of a firm stop", () => {
    const w = new WaveString(64);
    w.setTermination(20);
    w.pluck(0.5, 1);
    const e0 = w.energy();
    run(w, 300);
    for (let i = 0; i < 20; i++) expect(Math.abs(w.displacement(i))).toBeLessThan(1e-6);
    expect(w.energy()).toBeCloseTo(e0, 5); // lossless: stopped string keeps its energy
    // the stopped segment is shorter, so its round-trip period is shorter too
    expect(w.segmentLength).toBe(64 - 1 - 20);
  });

  it("a node touch filters out modes lacking a node there (flageolet)", () => {
    // seed the fundamental (one big antinode); a touch at the midpoint, which is
    // the fundamental's antinode, should bleed it away to near silence.
    const w = new WaveString(64);
    const mid = Math.round(0.5 * (w.n - 1));
    w.seedProfile((i) => Math.sin((Math.PI * i) / (w.n - 1)));
    const e0 = w.energy();
    for (let s = 0; s < 400; s++) {
      w.advance(1, { loss: 1, hfLoss: 0, nodeIndex: mid, nodeLoss: 0.4 });
    }
    expect(w.energy()).toBeLessThan(e0 * 0.05);
  });
});
