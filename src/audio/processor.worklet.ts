/**
 * Thin AudioWorklet wrapper around the pure-TS StringSim model.
 * Continuous controls arrive as k-rate AudioParams (smoothed further inside
 * the sim); discrete events (plucks, string changes) arrive via the port.
 * The processor periodically posts state (rms / slip / freq) back for the
 * visualisation.
 */
import { StringSim } from "./dsp/StringSim";

class StringProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "bowOn", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "bowVelocity", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "bowForce", defaultValue: 0.3, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "bowPosition", defaultValue: 0.88, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "fingerOn", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "fingerPosition", defaultValue: 0.3, minValue: -0.1, maxValue: 1, automationRate: "k-rate" },
      { name: "fingerPressure", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ] as const;
  }

  private sim = new StringSim(sampleRate);
  private framesSinceState = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      switch (m.type) {
        case "pluck":
          this.sim.pluck(m.force, m.widthMs);
          break;
        case "setString":
          this.sim.setString(m.spec);
          this.sim.reset();
          break;
        case "mute":
          this.sim.reset();
          break;
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0][0];
    const sim = this.sim;
    sim.bowOn = parameters.bowOn[0] > 0.5;
    sim.bowVelocity = parameters.bowVelocity[0];
    sim.bowForce = parameters.bowForce[0];
    sim.bowPosition = parameters.bowPosition[0];
    sim.fingerOn = parameters.fingerOn[0] > 0.5;
    sim.fingerPosition = parameters.fingerPosition[0];
    sim.fingerPressure = parameters.fingerPressure[0];
    sim.process(out);

    this.framesSinceState += out.length;
    if (this.framesSinceState >= 512) {
      this.framesSinceState = 0;
      this.port.postMessage({ type: "state", ...sim.getState() });
    }
    return true;
  }
}

registerProcessor("bowed-string", StringProcessor);
