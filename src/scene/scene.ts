/**
 * Three.js scene: a string stretched vertically across the whole viewport,
 * nut at the top, bridge at the bottom, fingerboard behind the upper part.
 * Provides an affine screen<->string mapping used by the input layer
 * (computed by projecting reference points, so it stays correct under any
 * camera/rotation).
 *
 * The instrument is drawn as a flat "vector illustration": layered
 * ShapeGeometry fills with crisp Line2 outlines, no lights and no lit
 * materials — deterministic on every GPU, cheap to render, and it reads
 * cleanly on both the light and dark themes (see ./theme.ts).
 */
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { VisualString } from "./visualString";
import { makeTools, ToolSet } from "./tools";
import { FINGERBOARD_END } from "../state";
import { currentTheme, onThemeChange, SceneTheme } from "./theme";

export const STRING_TOP = 2.1;
// the bottom end leaves room below for the bridge (and a glimpse of the
// belly) to stay visible above the bottom control panel, so you can see how
// close to it you bow
export const STRING_BOT = -1.45;
export const STRING_LEN = STRING_TOP - STRING_BOT;
export const BOARD_SURFACE_Z = -0.08;

// instrument palette: wood tones shared by both themes
const WOOD = {
  plate: 0x8e4d26, // varnished spruce top
  plateSheen: 0xa65f2f, // lighter centre, suggests the arching
  edge: 0x1f1209, // dark outline around the top plate
  purfling: 0x2b1a0c,
  fhole: 0x140c06,
  board: 0x16120f, // ebony fingerboard
  boardSheen: 0x241d17,
  nut: 0xe7dabd, // bone
  nutShadow: 0x453824,
  bridge: 0xddba8a, // maple
  bridgeLine: 0x6b4826,
  tailpiece: 0x1a1512,
  tailSheen: 0x322a23,
};

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene = new THREE.Scene();
  readonly instrument = new THREE.Group();
  readonly visual: VisualString;
  readonly tools: ToolSet;

  private nodeMarkers = new THREE.Group();
  private fingerContact: THREE.Mesh;
  private fatLineMats: LineMaterial[] = [];
  private stringTintMats: THREE.MeshBasicMaterial[] = [];

  // cached affine mapping screen px -> (s along string, x lateral world units)
  private mapOrigin = new THREE.Vector2();
  private mapVx = new THREE.Vector2();
  private mapVy = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.camera.position.set(0, 0, 6.4);

    // a whisper of rotation keeps some parallax between the flat layers (and
    // makes the string's z-depression under a firm finger faintly visible)
    this.instrument.rotation.y = -0.12;
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
        depthWrite: false,
      })
    );
    this.fingerContact.position.z = BOARD_SURFACE_Z + 0.005;
    this.instrument.add(this.fingerContact);

    this.applyTheme(currentTheme());
    onThemeChange((t) => this.applyTheme(t));

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  /** Everything the system colour scheme changes at runtime. */
  private applyTheme(t: SceneTheme): void {
    this.renderer.setClearColor(t.bg);
    this.visual.setTheme(t);
    for (const m of this.stringTintMats) m.color.set(t.string);
    const fc = this.fingerContact.material as THREE.MeshBasicMaterial;
    fc.blending = t.additiveGlow ? THREE.AdditiveBlending : THREE.NormalBlending;
    fc.needsUpdate = true;
  }

  private flat(color: number, opts: { opacity?: number } = {}): THREE.MeshBasicMaterial {
    const transparent = opts.opacity !== undefined && opts.opacity < 1;
    return new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent,
      opacity: opts.opacity ?? 1,
      depthWrite: !transparent,
    });
  }

  /** A crisp screen-space outline through `pts` (closed), at depth `z`. */
  private outline(pts: THREE.Vector2[], z: number, color: number, px: number): Line2 {
    const pos: number[] = [];
    for (const p of pts) pos.push(p.x, p.y, z);
    pos.push(pts[0].x, pts[0].y, z);
    const geo = new LineGeometry();
    geo.setPositions(pos);
    const mat = new LineMaterial({ color, linewidth: px, worldUnits: false });
    this.fatLineMats.push(mat);
    return new Line2(geo, mat);
  }

  private buildFurniture(): void {
    this.buildBody();
    this.buildBoardAndNut();
    this.buildBridgeAndTailpiece();
    this.buildNodeMarkers();
  }

  /** Violin top plate to real proportions: upper/lower bouts, C-bout waist
   * with protruding corners, purfling inset from a dark edge. The top edge
   * sits at 40% of the string length (so the fingerboard overhangs it), the
   * bridge lands in the C-bout, and the lower bout runs off the view. */
  private buildBody(): void {
    const outlineShape = violinOutline();
    const bodyTopY = this.sToY(0.4);
    const zPlate = -0.3;

    const body = new THREE.Group();
    body.position.set(0, bodyTopY, 0);

    const plate = new THREE.Mesh(new THREE.ShapeGeometry(outlineShape, 18), this.flat(WOOD.plate));
    plate.position.z = zPlate;
    body.add(plate);

    const pts = dedupe(outlineShape.getPoints(12));

    // subtle lighter centre: a scaled-down copy of the outline, suggesting
    // the arching of the top without any lighting
    const centroid = pts
      .reduce((a, p) => a.add(p), new THREE.Vector2())
      .multiplyScalar(1 / pts.length);
    const sheenPts = pts.map((p) => p.clone().sub(centroid).multiplyScalar(0.86).add(centroid));
    const sheen = new THREE.Mesh(
      new THREE.ShapeGeometry(new THREE.Shape(sheenPts)),
      this.flat(WOOD.plateSheen, { opacity: 0.32 })
    );
    sheen.position.z = zPlate + 0.005;
    body.add(sheen);

    body.add(this.outline(pts, zPlate + 0.015, WOOD.edge, 2.4));
    body.add(this.outline(inset(pts, 0.055, centroid), zPlate + 0.01, WOOD.purfling, 1.2));

    // f-holes flanking the bridge, nicks level with its feet
    for (const side of [-1, 1] as const) {
      const f = this.makeFHole();
      f.position.set(side * 0.4, STRING_BOT - 0.12 - bodyTopY, zPlate + 0.02);
      f.rotation.z = side * 0.14;
      f.scale.x = side;
      body.add(f);
    }

    this.instrument.add(body);
  }

  /** One f-hole (right-hand variant; mirror with scale.x = -1): two eyes of
   * different sizes joined by an S-curved stem, with the two middle nicks. */
  private makeFHole(): THREE.Group {
    const mat = this.flat(WOOD.fhole);
    const g = new THREE.Group();

    const stem = new THREE.Shape();
    stem.moveTo(-0.068, 0.24);
    stem.bezierCurveTo(-0.08, 0.03, -0.018, -0.04, 0.022, -0.255);
    stem.lineTo(0.068, -0.255);
    stem.bezierCurveTo(0.015, -0.03, -0.046, 0.04, -0.032, 0.245);
    stem.closePath();
    g.add(new THREE.Mesh(new THREE.ShapeGeometry(stem, 12), mat));

    const eyeT = new THREE.Mesh(new THREE.CircleGeometry(0.036, 20), mat);
    eyeT.position.set(-0.068, 0.27, 0);
    const eyeB = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), mat);
    eyeB.position.set(0.068, -0.285, 0);
    g.add(eyeT, eyeB);

    for (const [x0, dir] of [
      [-0.072, 1],
      [0.035, -1],
    ] as const) {
      const nick = new THREE.Shape();
      nick.moveTo(x0, 0.013);
      nick.lineTo(x0 + dir * 0.034, -0.004);
      nick.lineTo(x0, -0.021);
      nick.closePath();
      g.add(new THREE.Mesh(new THREE.ShapeGeometry(nick), mat));
    }
    return g;
  }

  /** Fingerboard (tapered, rounded end, faint sheen strip) and bone nut. */
  private buildBoardAndNut(): void {
    const boardTopY = STRING_TOP + 0.08;
    const boardEndY = this.sToY(FINGERBOARD_END);

    const bs = new THREE.Shape();
    bs.moveTo(-0.17, boardTopY);
    bs.lineTo(0.17, boardTopY);
    bs.lineTo(0.3, boardEndY + 0.08);
    bs.quadraticCurveTo(0, boardEndY - 0.12, -0.3, boardEndY + 0.08);
    bs.closePath();
    const board = new THREE.Mesh(new THREE.ShapeGeometry(bs, 10), this.flat(WOOD.board));
    board.position.z = BOARD_SURFACE_Z - 0.01;
    this.instrument.add(board);

    // a slim off-centre highlight, hinting at the board's polish and camber
    const sheen = new THREE.Shape();
    sheen.moveTo(0.055, boardTopY - 0.03);
    sheen.lineTo(0.09, boardTopY - 0.03);
    sheen.lineTo(0.155, boardEndY + 0.1);
    sheen.lineTo(0.1, boardEndY + 0.1);
    sheen.closePath();
    const sheenMesh = new THREE.Mesh(new THREE.ShapeGeometry(sheen), this.flat(WOOD.boardSheen));
    sheenMesh.position.z = BOARD_SURFACE_Z - 0.005;
    this.instrument.add(sheenMesh);

    // nut: a slim rounded bone bar right at the top of the string — a finger
    // can stop all the way up to it (on it, the string is effectively open)
    const nut = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRect(0.42, 0.075, 0.025)),
      this.flat(WOOD.nut)
    );
    nut.position.set(0, STRING_TOP + 0.045, -0.02);
    const nutShadow = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.014), this.flat(WOOD.nutShadow));
    nutShadow.position.set(0, STRING_TOP + 0.004, -0.02);
    this.instrument.add(nut, nutShadow);
  }

  /** Maple bridge (feet, kidneys and heart) carrying the string's end, and
   * the ebony tailpiece with the string's afterlength running down to it. */
  private buildBridgeAndTailpiece(): void {
    const b = new THREE.Shape();
    b.moveTo(-0.235, -0.07);
    b.quadraticCurveTo(0, 0.04, 0.235, -0.07); // crown
    b.quadraticCurveTo(0.27, -0.09, 0.252, -0.125); // ear
    b.quadraticCurveTo(0.205, -0.145, 0.2, -0.185); // waist notch
    b.quadraticCurveTo(0.198, -0.225, 0.252, -0.25); // out to the leg
    b.lineTo(0.288, -0.305);
    b.quadraticCurveTo(0.3, -0.325, 0.28, -0.335); // foot
    b.lineTo(0.125, -0.335);
    b.quadraticCurveTo(0, -0.21, -0.125, -0.335); // arch between the feet
    b.lineTo(-0.28, -0.335);
    b.quadraticCurveTo(-0.3, -0.325, -0.288, -0.305);
    b.lineTo(-0.252, -0.25);
    b.quadraticCurveTo(-0.198, -0.225, -0.2, -0.185);
    b.quadraticCurveTo(-0.205, -0.145, -0.252, -0.125);
    b.quadraticCurveTo(-0.27, -0.09, -0.235, -0.07);
    b.closePath();
    const heart = new THREE.Path();
    heart.absarc(0, -0.105, 0.022, 0, Math.PI * 2, true);
    b.holes.push(heart);
    for (const side of [-1, 1]) {
      const kidney = new THREE.Path();
      kidney.absellipse(side * 0.115, -0.17, 0.034, 0.022, 0, Math.PI * 2, true, side * 0.45);
      b.holes.push(kidney);
    }

    const bridge = new THREE.Group();
    // crown peak at local y≈+0.02, so the string's end rests on it
    bridge.position.set(0, STRING_BOT - 0.02, -0.02);
    bridge.add(new THREE.Mesh(new THREE.ShapeGeometry(b, 10), this.flat(WOOD.bridge)));
    const bridgeLine = this.outline(dedupe(b.getPoints(8)), 0.005, WOOD.bridgeLine, 1.4);
    bridge.add(bridgeLine);
    this.instrument.add(bridge);

    // tailpiece below, with the string's afterlength running down to it
    const t = new THREE.Shape();
    t.moveTo(-0.115, 0);
    t.quadraticCurveTo(0, 0.05, 0.115, 0);
    t.lineTo(0.185, -0.98);
    t.quadraticCurveTo(0.19, -1.13, 0, -1.14);
    t.quadraticCurveTo(-0.19, -1.13, -0.185, -0.98);
    t.closePath();
    const tail = new THREE.Mesh(new THREE.ShapeGeometry(t, 10), this.flat(WOOD.tailpiece));
    tail.position.set(0, -1.95, -0.06);
    const ridge = new THREE.Shape();
    ridge.moveTo(-0.018, 0.01);
    ridge.lineTo(0.018, 0.01);
    ridge.lineTo(0.03, -1.02);
    ridge.lineTo(-0.03, -1.02);
    ridge.closePath();
    const ridgeMesh = new THREE.Mesh(new THREE.ShapeGeometry(ridge), this.flat(WOOD.tailSheen));
    ridgeMesh.position.set(0, -1.95, -0.055);

    // in front of the bridge face, as on a real violin seen from the front
    const afterMat = this.flat(0xffffff);
    this.stringTintMats.push(afterMat);
    const afterLen = new THREE.Mesh(new THREE.PlaneGeometry(0.016, 0.48), afterMat);
    afterLen.position.set(0, STRING_BOT - 0.24, -0.005);
    this.instrument.add(tail, ridgeMesh, afterLen);
  }

  private buildNodeMarkers(): void {
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
        new THREE.CircleGeometry(0.035, 20),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85 })
      );
      dot.userData.p = p;
      dot.position.set(0.16, this.sToY(p), 0.02);
      this.nodeMarkers.add(dot);
    }
    this.instrument.add(this.nodeMarkers);
  }

  /** Reposition the harmonic node markers for the vibrating portion of the
   * string: relative to a firm stop at `stop` (0 = open string). */
  private nodeBase = -1;

  updateNodeMarkers(stop: number): void {
    if (stop === this.nodeBase) return;
    this.nodeBase = stop;
    for (const d of this.nodeMarkers.children) {
      const p = (d.userData as { p: number }).p;
      const abs = stop + p * (1 - stop);
      d.position.y = this.sToY(abs);
      d.visible = abs <= FINGERBOARD_END;
    }
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
    for (const m of this.fatLineMats) m.resolution.set(w, h);
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

/** Right half of the violin outline (top centre at the origin, y downward),
 * as cubic segments [c1x, c1y, c2x, c2y, x, y]. Direction breaks at the
 * segment joints give the protruding C-bout corners. */
const OUTLINE_HALF: number[][] = [
  [0.52, 0.02, 0.95, -0.28, 0.96, -0.8], // upper bout
  [0.98, -1.1, 0.8, -1.34, 0.7, -1.5], // in to the upper corner
  [0.44, -1.6, 0.47, -2.3, 0.73, -2.5], // C-bout waist to the lower corner
  [0.97, -2.62, 1.17, -2.8, 1.17, -3.1], // out into the lower bout
  [1.17, -3.55, 0.72, -3.9, 0, -3.9], // round to the bottom centre
];

function violinOutline(): THREE.Shape {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  for (const [c1x, c1y, c2x, c2y, x, y] of OUTLINE_HALF) sh.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
  for (let i = OUTLINE_HALF.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = OUTLINE_HALF[i];
    const [ex, ey] = i === 0 ? [0, 0] : [OUTLINE_HALF[i - 1][4], OUTLINE_HALF[i - 1][5]];
    sh.bezierCurveTo(-c2x, c2y, -c1x, c1y, -ex, ey);
  }
  return sh;
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const sh = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  sh.moveTo(x + r, y);
  sh.lineTo(x + w - r, y);
  sh.quadraticCurveTo(x + w, y, x + w, y + r);
  sh.lineTo(x + w, y + h - r);
  sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  sh.lineTo(x + r, y + h);
  sh.quadraticCurveTo(x, y + h, x, y + h - r);
  sh.lineTo(x, y + r);
  sh.quadraticCurveTo(x, y, x + r, y);
  return sh;
}

/** Drop consecutive duplicates (curve joints repeat their endpoints), which
 * would otherwise produce zero-length tangents in inset(). */
function dedupe(pts: THREE.Vector2[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (const p of pts) {
    if (out.length === 0 || out[out.length - 1].distanceTo(p) > 1e-5) out.push(p);
  }
  if (out.length > 1 && out[0].distanceTo(out[out.length - 1]) < 1e-5) out.pop();
  return out;
}

/** Offset a closed polyline inward by d along per-point normals (toward the
 * centroid — exact enough for the purfling line). At the sharp C-bout corner
 * tips the offset curve self-intersects and pokes outside the outline;
 * points landing outside are dropped, so the line sweeps across the corner
 * base instead of looping. */
function inset(pts: THREE.Vector2[], d: number, centroid: THREE.Vector2): THREE.Vector2[] {
  const n = pts.length;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const t = pts[(i + 1) % n].clone().sub(pts[(i - 1 + n) % n]).normalize();
    const nrm = new THREE.Vector2(t.y, -t.x);
    if (nrm.dot(centroid.clone().sub(p)) < 0) nrm.negate();
    const q = p.clone().addScaledVector(nrm, d);
    if (insidePolygon(q, pts)) out.push(q);
  }
  return out;
}

function insidePolygon(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
