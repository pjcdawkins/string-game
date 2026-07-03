import { SceneView } from "./scene/scene";
import { setToolOpacity } from "./scene/tools";
import { Interactions, BOW_MAX } from "./input/interactions";
import { Keyboard } from "./input/keyboard";
import { engine } from "./audio/engine";
import { detectPitch } from "./audio/pitch";
import { Hud } from "./ui/hud";
import { state, STRINGS, fingerStop, FINGER_RADIUS } from "./state";
import "./style.css";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const uiRoot = document.getElementById("ui") as HTMLElement;

const view = new SceneView(canvas);
const hud = new Hud(uiRoot);
const input = new Interactions(view, canvas);
new Keyboard(input);

// initialise the engine's string when audio first becomes available
let stringInitialised = false;

// Cap the visual update + render at ~30fps. The string is a slow-motion
// caricature, so 30fps reads identically to 60 while halving the per-frame
// geometry rebuild — meaningful headroom on weaker devices (e.g. older iPads).
// Audio runs in the worklet thread and is unaffected by this cap.
const FRAME_MS = 1000 / 30;
let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  // gate on elapsed time, with a few ms of slack so a 60Hz display lands every
  // other vsync (≈30fps) rather than dropping to 20 on the slightest jitter
  const elapsed = now - last;
  if (elapsed < FRAME_MS - 4) return;
  const dt = Math.min(0.05, elapsed / 1000);
  last = now;

  if (engine.started && !stringInitialised) {
    stringInitialised = true;
    engine.setString(STRINGS[state.stringIdx].spec);
  }

  view.setActiveString(state.stringIdx);
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
    bowEngaged: input.bowEngaged || state.autoBow || input.keyBowing,
    bowVelSign: input.bowVel >= 0 ? 1 : -1,
    rms: state.meter.rms,
    slipRatio: state.meter.slipRatio,
    slowMoHz: state.slowMo,
  });

  updateTools();
  view.setNodeMarkersVisible(state.markers);
  // node markers follow a firm stop: harmonics of the vibrating portion, which
  // begins at the fingertip's bridge-side edge (the terminating node)
  view.updateNodeMarkers(
    state.fingerOn && input.fingerPressure > 0.55 ? fingerStop(state.fingerPos) : 0
  );
  view.updateMapping();
  view.render();

  hud.updateMeters();
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

  if (state.tool === "bow") {
    // the bow never disappears: solid while stroking, a ghost resting at its
    // contact point otherwise (hovering previews where a stroke would land)
    t.bow.visible = true;
    const engaged = input.bowEngaged || state.autoBow || input.keyBowing;
    const atHover = !engaged && input.keyContactDir === 0 && hoverRight;
    const s = atHover ? Math.max(input.implementMin(), Math.min(BOW_MAX, hover!.s)) : input.bowPos;
    const x = atHover ? hover!.x * 0.25 : input.bowX * 0.25;
    t.bow.position.set(x, view.sToY(s), engaged ? 0.01 : 0.12);
    setToolOpacity(t.bow, engaged ? 1 : 0.45);
  } else {
    const mesh = state.tool === "pick" ? t.pick : t.rightFinger;
    if (input.grabbed) {
      mesh.visible = true;
      // the grab displacement is relative to the string's own lane
      mesh.position.set(
        view.activeLaneX(input.grabbed.p) + input.grabbed.dx,
        view.sToY(input.grabbed.p),
        0.06
      );
      setToolOpacity(mesh, 1);
    } else if (hoverRight) {
      mesh.visible = true;
      const s = Math.max(input.implementMin(), Math.min(BOW_MAX, hover!.s));
      mesh.position.set(hover!.x, view.sToY(s), 0.12);
      setToolOpacity(mesh, 0.45);
    }
  }

  // left-hand finger
  const lf = t.leftFinger;
  if (state.fingerOn) {
    lf.visible = true;
    const depth = Math.min(0.085, 0.1 * input.fingerPressure);
    lf.position.set(view.activeLaneX(state.fingerPos), view.sToY(state.fingerPos), 0.1 - depth);
    setToolOpacity(lf, 1);
    view.showFingerContact(state.fingerPos, input.fingerPressure > 0.7 ? 1 : 0);
  } else if (hoverLeft) {
    lf.visible = true;
    const s = Math.max(0.02, hover!.s);
    lf.position.set(view.activeLaneX(s), view.sToY(s), 0.16);
    setToolOpacity(lf, 0.45);
    view.showFingerContact(0, 0);
  } else {
    lf.visible = false;
    view.showFingerContact(0, 0);
  }
}

requestAnimationFrame(frame);

// debug/automation hook (used by e2e checks)
(window as unknown as Record<string, unknown>).__debug = { state, engine, view, input, FINGER_RADIUS };
