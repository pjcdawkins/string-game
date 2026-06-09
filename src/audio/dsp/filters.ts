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
