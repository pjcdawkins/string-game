/**
 * Main-thread audio engine: owns the AudioContext, the bowed-string
 * AudioWorklet node and an analyser for pitch detection. Exposes a small
 * imperative API used by the input layer and HUD.
 */
import workletUrl from "./processor.worklet.ts?worker&url";
import type { StringSpec } from "./dsp/StringSim";
import type { AudioMeter } from "../state";

/** Reverb tail length in seconds. Short enough to read as "room", not "hall". */
const REVERB_SECONDS = 1.6;
/** Wet mix level; kept low so the reverb stays an ambience, not an effect. */
const REVERB_WET = 0.18;

/**
 * Synthesize a small-room impulse response: exponentially decaying noise,
 * decorrelated per channel for stereo width, with a brief fade-in so the
 * direct sound isn't doubled by the very start of the tail.
 */
function makeImpulseResponse(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.round(REVERB_SECONDS * rate));
  const buffer = ctx.createBuffer(2, length, rate);
  const fadeIn = Math.min(length, Math.round(0.01 * rate));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      // ~60 dB down by the end of the buffer.
      const decay = Math.exp((-6.9 * i) / length);
      const ramp = i < fadeIn ? i / fadeIn : 1;
      data[i] = (Math.random() * 2 - 1) * decay * ramp;
    }
  }
  return buffer;
}

export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  private starting: Promise<void> | null = null;

  meter: AudioMeter = { rms: 0, slipRatio: 0, freq: 440, bowing: false };

  async ensureStarted(): Promise<void> {
    if (this.node) {
      // Already built. Safari/iOS suspends the context (e.g. after the tab is
      // backgrounded, or if the very first resume lost its gesture), so make
      // sure it is awake again. This runs inside the triggering user gesture.
      this.resumeNow();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.start();
    return this.starting;
  }

  get started(): boolean {
    return this.node !== null;
  }

  /** Resume the context synchronously from within a user gesture. iOS only
   * honours resume() while the gesture's activation is still live, so this
   * must be invoked directly from the event handler, never after an await. */
  private resumeNow(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  }

  private async start(): Promise<void> {
    // Older iPads only expose the webkit-prefixed constructor.
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio API is not supported in this environment");
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    try {
      // Kick the resume off *before* the async addModule below: on iOS Safari
      // the context starts suspended and can only be unlocked while the user
      // gesture that called start() is still active. Awaiting addModule first
      // would drop that activation and leave the context muted.
      const unlocked = ctx.resume().catch(() => {});
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, "bowed-string", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -9;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.1;
      // Light room reverb, mixed in parallel with the dry signal. The
      // analyser taps the dry path only so pitch detection is unaffected.
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      const wetGain = ctx.createGain();
      wetGain.gain.value = REVERB_WET;
      node.connect(analyser);
      analyser.connect(limiter);
      analyser.connect(convolver);
      convolver.connect(wetGain);
      wetGain.connect(limiter);
      limiter.connect(ctx.destination);
      node.port.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "state") {
          this.meter = {
            rms: e.data.rms,
            slipRatio: e.data.slipRatio,
            freq: e.data.freq,
            bowing: e.data.bowing,
          };
        }
      };
      this.node = node;
      this.analyser = analyser;
      await unlocked;
      // If the gesture had already expired by the time addModule resolved, the
      // resume above is a no-op on iOS; the next pointer gesture retries it via
      // ensureStarted() -> resumeNow().
      this.resumeNow();
    } catch (err) {
      // Worklet load failed (network, parse, CORS) or the context could not be
      // built. Tear down so the leaked context is released and a later gesture
      // can retry from scratch: ensureStarted() re-runs start() once `starting`
      // is cleared below.
      void ctx.close().catch(() => {});
      this.ctx = null;
      this.node = null;
      this.analyser = null;
      this.starting = null;
      throw err;
    }
  }

  private param(name: string): AudioParam | null {
    return this.node?.parameters.get(name) ?? null;
  }

  private setParam(name: string, v: number): void {
    const p = this.param(name);
    if (p) p.value = v;
  }

  setBow(on: boolean, velocity: number, force: number, position: number): void {
    this.setParam("bowOn", on ? 1 : 0);
    this.setParam("bowVelocity", velocity);
    this.setParam("bowForce", force);
    this.setParam("bowPosition", position);
  }

  setBowOn(on: boolean): void {
    this.setParam("bowOn", on ? 1 : 0);
  }

  setFinger(on: boolean, pos: number, pressure: number): void {
    this.setParam("fingerOn", on ? 1 : 0);
    this.setParam("fingerPosition", pos);
    this.setParam("fingerPressure", pressure);
  }

  pluck(position: number, force: number, widthMs: number, periodFrac = 0): void {
    if (!this.node) return;
    this.setParam("bowPosition", position);
    this.node.port.postMessage({ type: "pluck", force, widthMs, periodFrac });
  }

  setString(spec: StringSpec): void {
    this.node?.port.postMessage({ type: "setString", spec });
    this.meter.freq = spec.f0;
  }

  mute(): void {
    this.node?.port.postMessage({ type: "mute" });
  }
}

export const engine = new Engine();
