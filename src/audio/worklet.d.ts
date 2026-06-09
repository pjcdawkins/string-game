/* Ambient declarations for the AudioWorklet global scope (not in lib.dom). */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>
    ): boolean;
  }
): void;

declare const sampleRate: number;
