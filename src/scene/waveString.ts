/**
 * A digital-waveguide model of the *visible* string — the single state behind
 * every regime the renderer shows.
 *
 * The string is two travelling-wave rails: `right` runs toward the bridge,
 * `left` runs toward the nut. Each end is a rigid termination, so an arriving
 * wave reflects into the other rail with a sign flip (the end stays a node).
 * The physical displacement at point i is just the sum of the two rails there:
 *
 *     y[i] = right[i] + left[i]
 *
 * This is exactly the d'Alembert / Kelly–Lochbaum picture the *audio* engine
 * already uses. It matters here because it unifies what used to be two separate
 * drawing paths: a pluck is an initial displacement that splits and travels; a
 * ring-down is those halves reflecting with loss; a flageolet is a localised
 * loss that filters out every mode lacking a node there; a firm stop just moves
 * the left termination under the finger; and the bowed Helmholtz corner is a
 * shape the bow writes onto the string each frame. One buffer, one renderer —
 * so there is no second representation to drift out of phase or cancel.
 *
 * Pure math, no Three.js, so the propagation/reflection physics is unit-tested
 * (see test/wavestring.test.ts).
 */
export class WaveString {
  readonly n: number;
  private right: Float32Array;
  private left: Float32Array;
  /** left termination index: nut = 0; a firm stop moves it under the finger. */
  private nutIndex = 0;
  /** carried fractional sample so a non-integer steps-per-frame stays smooth. */
  private stepDebt = 0;
  /** displacement the bow is currently holding the string at (stick-slip). */
  private bowY = 0;
  /** whether the bow is gripping the string this instant (for the caller). */
  bowStuck = false;

  constructor(n: number) {
    this.n = n;
    this.right = new Float32Array(n);
    this.left = new Float32Array(n);
  }

  clear(): void {
    this.right.fill(0);
    this.left.fill(0);
    this.stepDebt = 0;
  }

  /** Move the left (nut-side) termination to this point index. */
  setTermination(nutIndex: number): void {
    this.nutIndex = Math.max(0, Math.min(this.n - 2, nutIndex | 0));
  }

  /** Length in points of the vibrating segment (one end-to-end traverse). */
  get segmentLength(): number {
    return this.n - 1 - this.nutIndex;
  }

  /** Displacement at point i (sum of the two rails). */
  displacement(i: number): number {
    return this.right[i] + this.left[i];
  }

  /** Largest |displacement| over the vibrating segment (for glow / metering). */
  peakAbs(): number {
    let m = 0;
    for (let i = this.nutIndex; i < this.n; i++) {
      const v = Math.abs(this.right[i] + this.left[i]);
      if (v > m) m = v;
    }
    return m;
  }

  /**
   * Total wave energy (sum of squared travelling samples). Unlike {@link peakAbs}
   * this is phase-independent — a vibrating string is momentarily straight twice
   * per cycle, so a single displacement snapshot is a poor amplitude measure.
   *
   * The sample in each rail pointing *into* a termination (left at the nut,
   * right at the bridge) is about to reflect and be discarded, so it is excluded
   * to avoid transiently double-counting it against its reflection.
   */
  energy(): number {
    let e = 0;
    for (let i = this.nutIndex; i < this.n - 1; i++) e += this.right[i] * this.right[i];
    for (let i = this.nutIndex + 1; i < this.n; i++) e += this.left[i] * this.left[i];
    return e;
  }

  /**
   * Write a displacement profile onto the string with zero velocity (each rail
   * carries half). This is how every *driven* excitation imposes its shape:
   * a held grab, the bowed Helmholtz corner, or a bowed flageolet's standing
   * mode. Released frames stop writing and {@link advance} takes over, so the
   * shape simply starts travelling — the ring-down is automatic and seamless.
   */
  seedProfile(profile: (i: number) => number): void {
    for (let i = 0; i < this.nutIndex; i++) {
      this.right[i] = 0;
      this.left[i] = 0;
    }
    for (let i = this.nutIndex; i < this.n; i++) {
      const h = 0.5 * profile(i);
      this.right[i] = h;
      this.left[i] = h;
    }
  }

  /**
   * Anchor the bow to wherever the string currently is at `index`, so a stroke
   * starts capturing from rest instead of yanking the string to some stale
   * hold position. Call this on the rising edge of a bow stroke.
   */
  anchorBow(index: number): void {
    this.bowY = this.right[index] + this.left[index];
    this.bowStuck = true;
  }

  /** Pluck: a triangle peaking at `pos` (0..1 within the vibrating segment). */
  pluck(pos: number, amp: number): void {
    const a = this.nutIndex;
    const b = this.n - 1;
    const peak = a + Math.max(0, Math.min(1, pos)) * (b - a);
    this.seedProfile((i) =>
      i <= peak
        ? (amp * (i - a)) / Math.max(1e-6, peak - a)
        : (amp * (b - i)) / Math.max(1e-6, b - peak),
    );
  }

  /**
   * Free vibration: propagate `dsamples` (fractional ok) of travel, reflecting
   * at both ends with `loss` (<1 damps), an optional high-frequency reflection
   * smoothing (`hfLoss`, brighter→duller as it rises), and an optional localised
   * node loss at `nodeIndex` (a touched flageolet, which filters the ring-down).
   */
  advance(dsamples: number, opts: AdvanceOpts): void {
    this.stepDebt += dsamples;
    let steps = Math.floor(this.stepDebt);
    this.stepDebt -= steps;
    if (steps > this.n) steps = this.n; // don't spiral after a long stall
    for (let s = 0; s < steps; s++) this.step(opts);
  }

  private step(opts: AdvanceOpts): void {
    const n = this.n;
    const a = this.nutIndex;
    const loss = opts.loss ?? 1;
    const hf = opts.hfLoss ?? 0;

    // propagate one sample: right toward the bridge, left toward the nut
    this.right.copyWithin(1, 0, n - 1);
    this.left.copyWithin(0, 1, n);

    // reflect the samples now arriving at each end into the opposite rail with a
    // sign flip, so the termination sums to zero (a node). A touch of HF loss
    // (averaging the reflected sample with its neighbour) damps high modes
    // faster than low ones, like real string/air losses.
    const arrNut = this.left[a];
    const arrBridge = this.right[n - 1];
    const nutNeighbour = a + 1 < n ? this.left[a + 1] : arrNut;
    const bridgeNeighbour = n - 2 >= 0 ? this.right[n - 2] : arrBridge;
    this.right[a] = -loss * (arrNut * (1 - hf) + nutNeighbour * hf);
    this.left[n - 1] = -loss * (arrBridge * (1 - hf) + bridgeNeighbour * hf);

    // dead region nut-side of a firm stop
    for (let i = 0; i < a; i++) {
      this.right[i] = 0;
      this.left[i] = 0;
    }

    // bow: a stick-slip interaction at the contact point. The bow tries to drag
    // the string along with it (stick); when the string's pull exceeds the grip
    // (set by bow force) it breaks away (slip) and the released corner travels
    // off on its own — the same waveguide that carries plucks and ring-down, so
    // the first big capture-then-release is the bite/ictus, and a fast, light
    // stroke (low grip) just slips without ever building that drag.
    const bow = opts.bow;
    if (bow) {
      const b = bow.index;
      const yFree = this.right[b] + this.left[b];
      let delta = this.bowY + bow.vel - yFree; // force needed to keep stuck
      if (Math.abs(delta) <= bow.grip) {
        this.bowY = yFree + delta; // stick: move with the bow
        this.bowStuck = true;
      } else {
        delta = Math.sign(delta) * bow.grip * bow.kinetic; // slip: kinetic drag only
        this.bowY = yFree + delta;
        this.bowStuck = false;
      }
      this.right[b] += 0.5 * delta;
      this.left[b] += 0.5 * delta;
    }

    // a light finger touch: bleed energy at the node so only modes with a node
    // there survive — the flageolet emerges from the ring-down on its own
    const j = opts.nodeIndex ?? -1;
    if (j >= 0) {
      const keep = 1 - (opts.nodeLoss ?? 0);
      for (let k = j - 1; k <= j + 1; k++) {
        if (k > a && k < n - 1) {
          this.right[k] *= keep;
          this.left[k] *= keep;
        }
      }
    }
  }
}

export interface AdvanceOpts {
  loss?: number; // per-reflection amplitude retention (1 = lossless)
  hfLoss?: number; // 0..0.5 extra damping of high modes at each reflection
  nodeIndex?: number; // point index of a touched flageolet node, or <0 for none
  nodeLoss?: number; // 0..1 energy bled per step at the node
  bow?: BowDrive; // stick-slip bow contact, or omit for free vibration
}

export interface BowDrive {
  index: number; // contact point index on the string
  vel: number; // per-step lateral drag of the bow (signed; sets amplitude)
  grip: number; // max displacement the bow can hold before slipping (~bow force)
  kinetic: number; // kinetic/static friction ratio (0..1) applied while slipping
}
