import type { StringSpec } from "./audio/dsp/StringSim";

export type Tool = "bow" | "pick" | "finger";
export type LeftMode = "press" | "touch";

export interface ViolinString {
  name: string;
  spec: StringSpec;
}

export const STRINGS: ViolinString[] = [
  { name: "G3", spec: { f0: 196.0, darkness: 0.45, loss: 0.35, stiffness: 0.25, nonlinearity: 0.35 } },
  { name: "D4", spec: { f0: 293.66, darkness: 0.35, loss: 0.3, stiffness: 0.2, nonlinearity: 0.25 } },
  { name: "A4", spec: { f0: 440.0, darkness: 0.28, loss: 0.3, stiffness: 0.15, nonlinearity: 0.15 } },
  { name: "E5", spec: { f0: 659.25, darkness: 0.15, loss: 0.25, stiffness: 0.1, nonlinearity: 0.06 } },
];

/** Fraction of the string length (from the nut) covered by the fingerboard.
 * The whole board is playable with the left hand, as on a real violin. */
export const FINGERBOARD_END = 0.84;

export interface AudioMeter {
  rms: number;
  slipRatio: number;
  freq: number;
  bowing: boolean;
}

export interface AppState {
  tool: Tool;
  stringIdx: number;
  leftMode: LeftMode;
  autoBow: boolean;
  bowForce: number; // 0..1.5
  autoBowSpeed: number; // 0..0.6
  fingerOn: boolean;
  fingerPos: number; // 0..1 from nut
  fingerPressure: number;
  vibrato: boolean;
  markers: boolean;
  snap: boolean;
  slowMo: number; // visual slow-motion factor (Hz of visual fundamental)
  meter: AudioMeter;
  detectedFreq: number;
}

export const state: AppState = {
  tool: "bow",
  stringIdx: 2, // A string
  leftMode: "press",
  autoBow: false,
  bowForce: 0.45,
  autoBowSpeed: 0.22,
  fingerOn: false,
  fingerPos: 0.3,
  fingerPressure: 0,
  vibrato: false,
  markers: true,
  snap: false,
  slowMo: 1.6,
  meter: { rms: 0, slipRatio: 0, freq: 440, bowing: false },
  detectedFreq: 0,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function freqToNote(freq: number): { name: string; cents: number } | null {
  if (freq <= 0) return null;
  const midi = 69 + 12 * Math.log2(freq / 440);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
  return { name, cents };
}

/** Equal-temperament stop position for `semis` semitones above the open string. */
export function semitonePos(semis: number): number {
  return 1 - Math.pow(2, -semis / 12);
}
