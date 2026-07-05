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
  private unlockHandlersInstalled = false;

  meter: AudioMeter = { rms: 0, slipRatio: 0, freq: 440, bowing: false };

  async ensureStarted(): Promise<void> {
    if (this.node) {
      // Already built. Safari/iOS suspends the context (e.g. after the tab is
      // backgrounded, or if the very first resume lost its gesture), so make
      // sure it is awake again. This runs inside the triggering user gesture.
      this.resumeNow();
      return;
    }
    if (this.starting) {
      // Still building (worklet module loading): retry the unlock with this
      // gesture too, in case the one that kicked off start() didn't take.
      this.resumeNow();
      return this.starting;
    }
    this.starting = this.start();
    return this.starting;
  }

  get started(): boolean {
    return this.node !== null;
  }

  /** True once the graph exists and the context is actually rendering audio —
   * i.e. sound would be heard right now. Polled by the HUD's sound hint. */
  get running(): boolean {
    return this.node !== null && this.ctx?.state === "running";
  }

  /** Build the whole audio graph ahead of the first gesture. Fetching and
   * compiling the worklet module is the slow part — a network round trip plus
   * compile, easily over a second on a phone's cache-cold first visit — and
   * deferring it to the first pointerdown used to spend the opening stroke(s)
   * in silence. Creating the context without user activation is fine: it just
   * starts suspended, and the first gesture merely resume()s it (near-instant)
   * via ensureStarted() / the unlock handlers. A prewarm failure is swallowed:
   * start()'s catch has already torn down and cleared `starting`, so the first
   * gesture retries from scratch exactly as it did before prewarming. */
  prewarm(): void {
    if (this.node || this.starting) return;
    this.starting = this.start();
    this.starting.catch(() => {});
  }

  /** Resume the context synchronously from within a user gesture. iOS only
   * honours resume() while the gesture's activation is still live, so this
   * must be invoked directly from the event handler, never after an await. */
  private resumeNow(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  }

  /** iOS mutes Web Audio entirely while the device is in Silent Mode, because
   * an AudioContext defaults to the "ambient" audio-session category. Media
   * playback ignores the silent switch, so opt into that category where the
   * Audio Session API exists (Safari 17+). */
  private static requestPlaybackSession(): void {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        // older WebKit builds expose the object but reject assignment
      }
    }
  }

  /** iOS WebKit grants the audio-unlock user activation reliably on the
   * *release* half of a gesture (pointerup / touchend / click); a
   * touch-derived pointerdown — where the app starts the engine — often does
   * not count. Keep permanent capture-phase listeners that retry resume();
   * they are no-ops once the context is running, and double as recovery when
   * iOS suspends the context after backgrounding the tab. The press-half
   * events matter too now that the graph is prewarmed before any gesture:
   * where the browser does grant activation on press (desktop, Android), they
   * unlock the very first touch anywhere on the page, not just the canvas. */
  private installUnlockHandlers(): void {
    if (this.unlockHandlersInstalled) return; // start() may be retried after a failure
    this.unlockHandlersInstalled = true;
    const unlock = (): void => this.resumeNow();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("pointerup", unlock, true);
    window.addEventListener("touchstart", unlock, true);
    window.addEventListener("touchend", unlock, true);
    window.addEventListener("click", unlock, true);
  }

  private async start(): Promise<void> {
    Engine.requestPlaybackSession();
    // Older iPads only expose the webkit-prefixed constructor.
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio API is not supported in this environment");
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.installUnlockHandlers();
    try {
      // Kick the resume off *before* the async addModule below: on iOS Safari
      // the context starts suspended and can only be unlocked while the user
      // gesture that called start() is still active. Awaiting addModule first
      // would drop that activation and leave the context muted. On a
      // pre-gesture prewarm this resume is premature — some browsers hold the
      // promise pending until activation arrives, others reject — which is
      // why it is never awaited on the main path below.
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
      // Retry the resume once the early attempt settles, in case the gesture
      // had expired by the time addModule resolved. Deliberately not awaited:
      // on a pre-gesture prewarm that promise can stay pending until the
      // first real gesture, and start() must still resolve so the graph is
      // usable the moment the unlock handlers get the context running.
      void unlocked.then(() => this.resumeNow());
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
