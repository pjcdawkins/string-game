import { SceneView } from "./scene/scene";
import { setToolOpacity } from "./scene/tools";
import { Interactions, BOW_MIN } from "./input/interactions";
import { engine } from "./audio/engine";
import { detectPitch } from "./audio/pitch";
import { Hud } from "./ui/hud";
import { Challenge } from "./ui/challenge";
import { state, STRINGS } from "./state";
import "./style.css";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const uiRoot = document.getElementById("ui") as HTMLElement;

const view = new SceneView(canvas);
const hud = new Hud(uiRoot);
const challenge = new Challenge(uiRoot, hud.challengeButton);
const input = new Interactions(view, canvas);

// initialise the engine's string when audio first becomes available
let stringInitialised = false;

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (engine.started && !stringInitialised) {
    stringInitialised = true;
    engine.setString(STRINGS[state.stringIdx].spec);
  }

  engine.tick(dt);
  input.update(dt);
  state.meter = engine.meter;
  if (engine.analyser) {
    state.detectedFreq = detectPitch(engine.analyser, engine.analyser.context.sampleRate);
  }

  // --- visual string
  view.visual.update(dt, {
    grabbed: input.grabbed,
    fingerOn: state.fingerOn,
    fingerPos: state.fingerPos,
    fingerPressure: input.fingerPressure,
    bowing: state.meter.bowing,
    bowEngaged: input.bowEngaged || state.autoBow,
    bowVelSign: input.bowVel >= 0 ? 1 : -1,
    rms: state.meter.rms,
    slipRatio: state.meter.slipRatio,
    slowMoHz: state.slowMo,
  });

  updateTools();
  view.setNodeMarkersVisible(state.markers);
  view.updateMapping();
  view.render();

  hud.updateMeters();
  challenge.update(dt);
  requestAnimationFrame(frame);
}

function updateTools(): void {
  const t = view.tools;
  t.bow.visible = false;
  t.pick.visible = false;
  t.rightFinger.visible = false;

  const hover = input.hover;
  const boundary = input.zoneBoundary();
  const hoverRight = hover && hover.s >= boundary && hover.s <= 1.05;
  const hoverLeft = hover && hover.s > -0.02 && hover.s < boundary;

  // note guide: show what the cursor position would sound under the finger
  hud.setHoverPosition(hoverLeft && !state.fingerOn ? hover!.s : null);

  if (state.tool === "bow" && (input.bowEngaged || state.autoBow || hoverRight)) {
    t.bow.visible = true;
    const engaged = input.bowEngaged || state.autoBow;
    const s = engaged ? input.bowPos : Math.max(BOW_MIN, Math.min(0.97, hover!.s));
    const x = engaged ? input.bowX * 0.25 : hover!.x * 0.25;
    t.bow.position.set(x, view.sToY(s), engaged ? 0.01 : 0.12);
    setToolOpacity(t.bow, engaged ? 1 : 0.45);
  } else if (state.tool !== "bow") {
    const mesh = state.tool === "pick" ? t.pick : t.rightFinger;
    if (input.grabbed) {
      mesh.visible = true;
      mesh.position.set(input.grabbed.dx, view.sToY(input.grabbed.p), 0.06);
      setToolOpacity(mesh, 1);
    } else if (hoverRight) {
      mesh.visible = true;
      mesh.position.set(hover!.x, view.sToY(hover!.s), 0.12);
      setToolOpacity(mesh, 0.45);
    }
  }

  // left-hand finger
  const lf = t.leftFinger;
  if (state.fingerOn) {
    lf.visible = true;
    const depth = Math.min(0.085, 0.1 * input.fingerPressure);
    lf.position.set(0, view.sToY(state.fingerPos), 0.1 - depth);
    setToolOpacity(lf, 1);
    view.showFingerContact(state.fingerPos, input.fingerPressure > 0.7 ? 1 : 0);
  } else if (hoverLeft) {
    lf.visible = true;
    lf.position.set(0, view.sToY(Math.max(0.02, hover!.s)), 0.16);
    setToolOpacity(lf, 0.45);
    view.showFingerContact(0, 0);
  } else {
    lf.visible = false;
    view.showFingerContact(0, 0);
  }
}

requestAnimationFrame(frame);

// debug/automation hook (used by e2e checks)
(window as unknown as Record<string, unknown>).__debug = { state, engine, view, input };
