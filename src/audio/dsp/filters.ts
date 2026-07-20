/**
 * Small DSP building blocks shared by the string simulation.
 * Pure TypeScript, no Web Audio / DOM dependencies, so everything here
 * can be unit-tested in Node.
 */

/** Ring-buffer delay line with linear-interpolated fractional read. */
export class DelayLine {
  private buf: Float32Array;
  private mask: number;
  private writeIdx = 0;

  constructor(maxDelay: number) {
    // power-of-two size for cheap wrapping
    let size = 1;
    while (size < maxDelay + 4) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  /** Read the sample written `delay` steps ago (delay >= 1, fractional ok). */
  read(delay: number): number {
    const pos = this.writeIdx - delay;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = this.buf[i0 & this.mask];
    const b = this.buf[(i0 + 1) & this.mask];
    return a + frac * (b - a);
  }

  write(x: number): void {
    this.buf[this.writeIdx & this.mask] = x;
    this.writeIdx++;
  }

  clear(): void {
    this.buf.fill(0);
  }
}

/** One-pole lowpass used as the lossy bridge reflection filter. */
export class OnePoleLP {
  private y1 = 0;
  a = 0.3; // 0 = no filtering, ->1 = darker
  gain = 0.997;

  process(x: number): number {
    this.y1 = (1 - this.a) * x + this.a * this.y1;
    return this.gain * this.y1;
  }

  /** Approximate phase delay in samples at low frequencies. */
  phaseDelay(): number {
    return this.a / (1 - this.a);
  }

  clear(): void {
    this.y1 = 0;
  }
}

/** First-order allpass for string stiffness (dispersion). */
export class AllpassDispersion {
  private x1 = 0;
  private y1 = 0;
  c = 0; // coefficient in (-1, 1); 0 = bypass

  process(x: number): number {
    const y = this.c * x + this.x1 - this.c * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  /** Group delay at DC in samples. */
  delayAtDC(): number {
    return (1 - this.c) / (1 + this.c);
  }

  clear(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/** RBJ constant-peak bandpass biquad, used for body resonances. */
export class BiquadBP {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  gain = 1;

  set(freq: number, q: number, gain: number, fs: number): void {
    this.gain = gain;
    const w0 = (2 * Math.PI * freq) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return this.gain * y;
  }

  clear(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** DC blocker. */
export class DCBlocker {
  private x1 = 0;
  private y1 = 0;

  process(x: number): number {
    const y = x - this.x1 + 0.995 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  clear(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/**
 * Center-weighted moving average modelling a bow-hair ribbon's contact patch.
 * The friction at the bow responds to the string velocity averaged across the
 * hair, and a real ribbon presses hardest at its centre — so the weighting is a
 * triangular (Bartlett) profile, not a flat boxcar. A triangle is the
 * convolution of two rectangles, so it is realised here as two cascaded boxcars
 * and still costs O(1) per sample. Versus a flat window of the same span the
 * triangle has a much gentler high-frequency roll-off (no deep sinc notches),
 * so it averages slip timing to tame double-slip while keeping more of the
 * bright sul-ponticello partials.
 *
 * The single boxcar length is `halfLen` (L); the resulting triangular window
 * spans 2L-1 samples with an equivalent smoothing width of ~L. halfLen = 1 is a
 * pass-through — a mathematical point contact.
 */
export class RibbonAverager {
  private r1: Float64Array; // float64 so each running sum subtracts exactly what
  private r2: Float64Array; // it added (no float32 truncation drift over a stroke)
  private p1 = 0;
  private p2 = 0;
  private s1 = 0;
  private s2 = 0;
  private len = 1;

  constructor(maxHalfLen: number) {
    this.r1 = new Float64Array(Math.max(1, maxHalfLen));
    this.r2 = new Float64Array(Math.max(1, maxHalfLen));
  }

  /** Set the boxcar half-length L (triangular base spans 2L-1 samples). Resets
   * the running state when the length changes so no sum spans a stale window. */
  setHalfLength(L: number): void {
    const clamped = Math.max(1, Math.min(this.r1.length, Math.floor(L)));
    if (clamped === this.len) return;
    this.len = clamped;
    this.clear();
  }

  process(x: number): number {
    const L = this.len;
    this.s1 += x - this.r1[this.p1];
    this.r1[this.p1] = x;
    if (++this.p1 >= L) this.p1 = 0;
    const a1 = this.s1 / L;
    this.s2 += a1 - this.r2[this.p2];
    this.r2[this.p2] = a1;
    if (++this.p2 >= L) this.p2 = 0;
    return this.s2 / L;
  }

  clear(): void {
    this.r1.fill(0);
    this.r2.fill(0);
    this.p1 = this.p2 = this.s1 = this.s2 = 0;
  }
}

/** Per-sample exponential smoother for control parameters. */
export class Smoother {
  value: number;
  private coeff: number;

  constructor(initial: number, timeConstantSamples: number) {
    this.value = initial;
    this.coeff = 1 - Math.exp(-1 / Math.max(1, timeConstantSamples));
  }

  setTimeConstant(samples: number): void {
    this.coeff = 1 - Math.exp(-1 / Math.max(1, samples));
  }

  tick(target: number): number {
    this.value += this.coeff * (target - this.value);
    return this.value;
  }

  jump(v: number): void {
    this.value = v;
  }
}
