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
import { FINGERBOARD_END, semitonePos } from "../state";

export const STRING_TOP = 2.1;
export const STRING_BOT = -2.1;
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
  private semitoneTicks = new THREE.Group();
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
    // fingerboard
    const boardLen = FINGERBOARD_END * STRING_LEN + 0.1;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, boardLen, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x171210, roughness: 0.32, metalness: 0.1 })
    );
    board.position.set(0, STRING_TOP + 0.06 - boardLen / 2, BOARD_SURFACE_Z - 0.07);
    this.instrument.add(board);

    // nut
    const nut = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.1, 0.13),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc8, roughness: 0.55 })
    );
    nut.position.set(0, STRING_TOP + 0.05, -0.035);
    this.instrument.add(nut);

    // bridge
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.16, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xc89a64, roughness: 0.5 })
    );
    bridge.position.set(0, STRING_BOT - 0.08, -0.03);
    this.instrument.add(bridge);

    // a hint of spruce top below the fingerboard
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, STRING_LEN * (1 - FINGERBOARD_END) + 0.5, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x271c12, roughness: 0.6 })
    );
    const topLen = STRING_LEN * (1 - FINGERBOARD_END) + 0.5;
    top.position.set(0, STRING_BOT - 0.2 + topLen / 2, -0.3);
    this.instrument.add(top);

    // equal-temperament position ticks on the board
    const tickMat = new THREE.MeshBasicMaterial({ color: 0x6a584a });
    const tickMatStrong = new THREE.MeshBasicMaterial({ color: 0xa08767 });
    const strong = new Set([2, 4, 5, 7, 9, 12]);
    for (let m = 1; m <= 12; m++) {
      const p = semitonePos(m);
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(strong.has(m) ? 0.3 : 0.18, 0.012, 0.005),
        strong.has(m) ? tickMatStrong : tickMat
      );
      tick.position.set(0, this.sToY(p), BOARD_SURFACE_Z + 0.004);
      this.semitoneTicks.add(tick);
    }
    this.instrument.add(this.semitoneTicks);

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

  setMarkersVisible(ticks: boolean, nodes: boolean): void {
    this.semitoneTicks.visible = ticks;
    this.nodeMarkers.visible = nodes;
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
