/**
 * Main-thread audio engine: owns the AudioContext, the bowed-string
 * AudioWorklet node and an analyser for pitch detection. Exposes a small
 * imperative API used by the input layer and HUD.
 */
import workletUrl from "./processor.worklet.ts?worker&url";
import type { StringSpec } from "./dsp/StringSim";
import type { AudioMeter } from "../state";

export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  private starting: Promise<void> | null = null;

  meter: AudioMeter = { rms: 0, slipRatio: 0, freq: 440, bowing: false };

  // vibrato modulation applied on top of the base finger position
  vibratoOn = false;
  vibratoRate = 5.5;
  vibratoDepth = 0.006;
  private vibPhase = 0;
  private baseFingerPos = 0.3;

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
    if (ctx && ctx.state !== "running") this.unlock(ctx);
  }

  /**
   * Unlock Web Audio from within a user gesture. Must run synchronously inside
   * the event handler (no preceding await) so the gesture's activation is still
   * live.
   *
   * resume() on its own is *not* reliable on mobile: iOS Safari only truly
   * starts the audio session when a source node is actually started during the
   * gesture, and a fresh Android Chrome (no Media Engagement Index, unlike a
   * desktop you have used before) likewise needs a real in-gesture start. So we
   * resume *and* fire a one-sample silent buffer through the destination — the
   * canonical unlock that works across Safari/iOS and Chrome.
   */
  private unlock(ctx: AudioContext): void {
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      // On a context that stays suspended, audio time never advances, so the
      // source stays started-but-unfinished with a live edge to destination;
      // repeated unlock attempts would pile these up. Release each one once it
      // actually completes (after the context finally resumes).
      src.onended = () => src.disconnect();
      src.start(0);
    } catch {
      // createBuffer/start can throw if the context is already closed; the next
      // gesture retries, so there is nothing useful to do here.
    }
  }

  private async start(): Promise<void> {
    // Older iPads only expose the webkit-prefixed constructor.
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio API is not supported in this environment");
    // On iOS 16.4+ the default audio session follows the hardware mute switch,
    // which silences Web Audio (but not <audio>/<video>) even when everything
    // else is correct — a common "no sound on Safari" cause. Asking for the
    // "playback" session makes the instrument audible regardless of the switch.
    setAudioSessionPlayback();
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    try {
      // Unlock *before* the async addModule below: on iOS Safari the context
      // starts suspended and can only be unlocked while the user gesture that
      // called start() is still active. Awaiting addModule first would drop that
      // activation and leave the context muted. resume() alone is unreliable on
      // mobile, so unlock() also starts a silent source within the gesture.
      this.unlock(ctx);
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
      node.connect(analyser);
      analyser.connect(limiter);
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
      // If the gesture had already expired by the time addModule resolved, the
      // in-gesture unlock above already did the work; this is a best-effort
      // retry, and any later pointer gesture retries again via
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
    this.baseFingerPos = pos;
    this.setParam("fingerOn", on ? 1 : 0);
    this.setParam("fingerPosition", pos);
    this.setParam("fingerPressure", pressure);
  }

  pluck(position: number, force: number, widthMs: number): void {
    if (!this.node) return;
    this.setParam("bowPosition", position);
    this.node.port.postMessage({ type: "pluck", force, widthMs });
  }

  setString(spec: StringSpec): void {
    this.node?.port.postMessage({ type: "setString", spec });
    this.meter.freq = spec.f0;
  }

  mute(): void {
    this.node?.port.postMessage({ type: "mute" });
  }

  /** Called once per animation frame; applies vibrato wobble. */
  tick(dt: number): void {
    if (!this.node) return;
    if (this.vibratoOn) {
      this.vibPhase += dt * this.vibratoRate * 2 * Math.PI;
      const offset = Math.sin(this.vibPhase) * this.vibratoDepth;
      this.setParam("fingerPosition", this.baseFingerPos + offset);
    }
  }
}

/** Route Web Audio through the "playback" audio session on browsers that
 * support the (experimental) Audio Session API — chiefly iOS 16.4+ Safari —
 * so the hardware mute switch does not silence the instrument. A no-op
 * elsewhere. */
function setAudioSessionPlayback(): void {
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (session) {
    try {
      session.type = "playback";
    } catch {
      // Some implementations expose the property read-only or reject unknown
      // values; the engine works fine without it.
    }
  }
}

export const engine = new Engine();
