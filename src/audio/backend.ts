/**
 * The contract between the *player* and the *sound engine* — the seam a DAW
 * plugin would slot into.
 *
 * Today the input layer (pointer gestures) and the keyboard layer call a small
 * imperative API on the AudioWorklet-backed {@link Engine}. Naming that surface
 * as an interface changes nothing at runtime, but it makes the boundary
 * explicit: anything that satisfies `StringBackend` can drive the instrument,
 * and the input/visual layers never learn whether the sound is coming from a
 * Web Audio worklet in a browser tab or from a native/WASM port of the same
 * {@link StringSim} running in a DAW's realtime callback.
 *
 * The continuous controls below map 1:1 onto the worklet's `parameterDescriptors`
 * (bowOn, bowVelocity, bowForce, bowPosition, fingerOn, fingerPosition,
 * fingerPressure) — which is already, in effect, a VST/AU/CLAP automation
 * manifest. A plugin backend exposes those seven as host-automatable parameters;
 * the discrete events (pluck / setString / mute) become plugin messages or MIDI.
 *
 * See PLUGIN_PORT.md for how a second backend (native + embedded-WebView GUI)
 * drops in on the far side of this interface.
 */
import type { StringSpec } from "./dsp/StringSim";
import type { AudioMeter } from "../state";

export interface StringBackend {
  /** Bring the engine up; idempotent. Web: build/resume the AudioContext and
   * load the worklet. Native: no-op (the host owns the audio thread). */
  ensureStarted(): Promise<void>;
  /** True once the graph exists and is ready to make sound. */
  readonly started: boolean;

  // --- continuous control (the seven automatable parameters) ---
  setBow(on: boolean, velocity: number, force: number, position: number): void;
  setBowOn(on: boolean): void;
  setFinger(on: boolean, pos: number, pressure: number): void;

  // --- discrete events ---
  pluck(position: number, force: number, widthMs: number, periodFrac?: number): void;
  setString(spec: StringSpec): void;
  mute(): void;

  /** Telemetry out, polled once per visual frame to drive the slow-motion
   * caricature (rms / slipRatio / freq / bowing). Web: posted from the worklet
   * over its port. Native: read straight off `StringSim.getState()`. */
  readonly meter: AudioMeter;
}
