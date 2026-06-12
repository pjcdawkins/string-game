/**
 * Three.js scene: a string stretched vertically across the whole viewport,
 * nut at the top, bridge at the bottom, fingerboard behind the upper part.
 * Provides an affine screen<->string mapping used by the input layer
 * (computed by projecting reference points, so it stays correct under any
 * camera/rotation).
 */
import * as THREE from "three";
import { VisualString } from "./visualString";
import { makeTools, ToolSet } from "./tools";
import { FINGERBOARD_END } from "../state";

export const STRING_TOP = 2.1;
// the bottom end leaves room below for the bridge (and a glimpse of the
// belly) to stay visible above the bottom control panel, so you can see how
// close to it you bow
export const STRING_BOT = -1.45;
export const STRING_LEN = STRING_TOP - STRING_BOT;
export const BOARD_SURFACE_Z = -0.08;

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene = new THREE.Scene();
  readonly instrument = new THREE.Group();
  readonly visual: VisualString;
  readonly tools: ToolSet;

  private nodeMarkers = new THREE.Group();
  private fingerContact: THREE.Mesh;

  // cached affine mapping screen px -> (s along string, x lateral world units)
  private mapOrigin = new THREE.Vector2();
  private mapVx = new THREE.Vector2();
  private mapVy = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x0b0e14);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.camera.position.set(0, 0, 6.4);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xfff2e0, 1.4);
    key.position.set(2.5, 3, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
    rim.position.set(-3, -2, 2);
    this.scene.add(rim);

    this.instrument.rotation.y = -0.16;
    this.scene.add(this.instrument);

    this.buildFurniture();
    this.visual = new VisualString(STRING_TOP, STRING_BOT);
    this.instrument.add(this.visual.group);
    this.tools = makeTools(this.instrument);

    this.fingerContact = new THREE.Mesh(
      new THREE.CircleGeometry(0.09, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffd27f,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.fingerContact.position.z = BOARD_SURFACE_Z + 0.005;
    this.instrument.add(this.fingerContact);

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private buildFurniture(): void {
    // fingerboard: tapered (narrow at the nut, wide at its end) and, as on a
    // real violin, extending well over the body — past the playable
    // left-hand zone, under the sul tasto bowing region
    const boardTopY = STRING_TOP + 0.06;
    const boardEndY = this.sToY(FINGERBOARD_END);
    const boardShape = new THREE.Shape();
    boardShape.moveTo(-0.17, boardTopY);
    boardShape.lineTo(0.17, boardTopY);
    boardShape.lineTo(0.3, boardEndY);
    boardShape.lineTo(-0.3, boardEndY);
    boardShape.closePath();
    const board = new THREE.Mesh(
      new THREE.ExtrudeGeometry(boardShape, { depth: 0.14, bevelEnabled: false }),
      new THREE.MeshStandardMaterial({ color: 0x171210, roughness: 0.32, metalness: 0.1 })
    );
    board.position.z = BOARD_SURFACE_Z - 0.14;
    this.instrument.add(board);

    // nut
    const nut = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.1, 0.13),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc8, roughness: 0.55 })
    );
    nut.position.set(0, STRING_TOP + 0.05, -0.035);
    this.instrument.add(nut);

    // bridge: a plain straight line, its top edge carrying the string's end
    const bridge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.56, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xd8b88a })
    );
    bridge.position.set(0, STRING_BOT - 0.02, -0.02);
    this.instrument.add(bridge);

    // violin body, roughly to real proportions: the top edge sits at 40% of
    // the string length (so the fingerboard overhangs it), the bridge lands
    // at the C-bout waist at ~55% of the body length, and the lower bout
    // runs off the bottom of the view
    const half = (sign: number, sh: THREE.Shape): void => {
      sh.bezierCurveTo(sign * 0.5, 0.06, sign * 0.97, -0.3, sign * 0.91, -1.0);
      sh.bezierCurveTo(sign * 0.86, -1.45, sign * 0.6, -1.5, sign * 0.56, -1.85);
      sh.bezierCurveTo(sign * 0.52, -2.2, sign * 0.95, -2.4, sign * 1.1, -2.9);
      sh.bezierCurveTo(sign * 1.2, -3.45, sign * 0.65, -3.85, 0, -3.85);
    };
    const outline = new THREE.Shape();
    outline.moveTo(0, 0);
    half(1, outline);
    // mirror back up the other side
    const mirrored = new THREE.Shape();
    mirrored.moveTo(0, -3.85);
    mirrored.bezierCurveTo(-0.65, -3.85, -1.2, -3.45, -1.1, -2.9);
    mirrored.bezierCurveTo(-0.95, -2.4, -0.52, -2.2, -0.56, -1.85);
    mirrored.bezierCurveTo(-0.6, -1.5, -0.86, -1.45, -0.91, -1.0);
    mirrored.bezierCurveTo(-0.97, -0.3, -0.5, 0.06, 0, 0);
    for (const c of mirrored.curves) outline.curves.push(c);
    const bodyGeo = new THREE.ExtrudeGeometry(outline, {
      depth: 0.22,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.045,
      bevelSegments: 2,
      curveSegments: 24,
    });
    const bodyTopY = this.sToY(0.4);
    const body = new THREE.Mesh(
      bodyGeo,
      new THREE.MeshStandardMaterial({ color: 0x3a2417, roughness: 0.45, metalness: 0.05 })
    );
    body.position.set(0, bodyTopY, -0.47);
    this.instrument.add(body);

    // f-holes flanking the bridge: a gently bowed slit with an eye at each
    // end, tops leaning toward the centre
    for (const side of [-1, 1]) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x0d0905 });
      const bend = side * 0.06;
      const slit = new THREE.Shape();
      slit.moveTo(-0.022, 0.2);
      slit.quadraticCurveTo(bend - 0.022, 0, -0.022, -0.2);
      slit.lineTo(0.022, -0.2);
      slit.quadraticCurveTo(bend + 0.022, 0, 0.022, 0.2);
      slit.closePath();
      const fhole = new THREE.Group();
      fhole.add(new THREE.Mesh(new THREE.ShapeGeometry(slit, 16), mat));
      const eyeT = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), mat);
      eyeT.position.y = 0.24;
      const eyeB = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), mat);
      eyeB.position.y = -0.24;
      fhole.add(eyeT, eyeB);
      fhole.position.set(side * 0.42, STRING_BOT + 0.05, -0.19);
      fhole.rotation.z = side * 0.18;
      this.instrument.add(fhole);
    }

    // natural-harmonic node markers (n = 2..6)
    const nodes = new Map<number, number>(); // position -> lowest harmonic number
    for (let n = 2; n <= 6; n++) {
      for (let k = 1; k < n; k++) {
        if (gcd(k, n) !== 1) continue;
        const p = k / n;
        if (p > FINGERBOARD_END) continue;
        if (!nodes.has(p)) nodes.set(p, n);
      }
    }
    for (const [p, n] of nodes) {
      const c = new THREE.Color().setHSL(0.52 + (n - 2) * 0.07, 0.8, 0.6);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 14, 10),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85 })
      );
      dot.position.set(0.16, this.sToY(p), 0.02);
      this.nodeMarkers.add(dot);
    }
    this.instrument.add(this.nodeMarkers);
  }

  sToY(s: number): number {
    return STRING_TOP - s * STRING_LEN;
  }

  setNodeMarkersVisible(visible: boolean): void {
    this.nodeMarkers.visible = visible;
  }

  showFingerContact(s: number, strength: number): void {
    const mat = this.fingerContact.material as THREE.MeshBasicMaterial;
    mat.opacity = strength * 0.55;
    this.fingerContact.position.y = this.sToY(s);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.visual.setResolution(w, h);
    this.updateMapping();
  }

  /** Recompute the affine screen mapping from projected reference points. */
  updateMapping(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const project = (v: THREE.Vector3): THREE.Vector2 => {
      const p = v.clone();
      this.instrument.localToWorld(p);
      p.project(this.camera);
      return new THREE.Vector2(((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h);
    };
    const o = project(new THREE.Vector3(0, STRING_TOP, 0));
    const px = project(new THREE.Vector3(1, STRING_TOP, 0));
    const py = project(new THREE.Vector3(0, STRING_BOT, 0));
    this.mapOrigin.copy(o);
    this.mapVx.copy(px.sub(o));
    this.mapVy.copy(py.sub(o));
  }

  /** Inverse of screenToString: string coordinates to client pixels. */
  stringToScreen(s: number, x: number): { clientX: number; clientY: number } {
    return {
      clientX: this.mapOrigin.x + this.mapVx.x * x + this.mapVy.x * s,
      clientY: this.mapOrigin.y + this.mapVx.y * x + this.mapVy.y * s,
    };
  }

  /** Convert client pixels to string coordinates {s: 0..1 nut->bridge, x: world units}. */
  screenToString(clientX: number, clientY: number): { s: number; x: number } {
    const dx = clientX - this.mapOrigin.x;
    const dy = clientY - this.mapOrigin.y;
    const det = this.mapVx.x * this.mapVy.y - this.mapVx.y * this.mapVy.x;
    if (Math.abs(det) < 1e-6) return { s: 0.5, x: 0 };
    const x = (dx * this.mapVy.y - dy * this.mapVy.x) / det;
    const s = (this.mapVx.x * dy - this.mapVx.y * dx) / det;
    return { s, x };
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
