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
export const STRING_BOT = -1.62;
export const STRING_LEN = STRING_TOP - STRING_BOT;
export const BOARD_SURFACE_Z = -0.08;

// Fake raked perspective, baked into the flat artwork rather than a camera
// tilt (which would make the screen<->string mapping non-affine): the body
// keeps true proportions from its top edge down to the bridge line (that
// span is pinned by the string), and everything below the bridge — the
// region nearest the viewer — is progressively squashed, as real
// foreshortening would. The bridge itself is squashed harder and shows its
// top edge, as if seen from slightly above. The playable string and
// fingerboard stay straight-on, so pointer accuracy is untouched; the
// compression frees vertical screen space for the string.
const LOWER_SQUASH = 0.55; // vertical scale well below the bridge
const SQUASH_RAMP0 = 0.2; // squash blends in between these distances
const SQUASH_RAMP1 = 0.6; // below the bridge line (body-local units)
const BRIDGE_SQUASH = 0.62;
const BODY_LEN = 3.9; // outline design length (see OUTLINE_HALF)
const BRIDGE_AT = 0.55; // bridge sits at 55% of the body length (C-bout)
const BODY_TOP_S = 0.4; // body top edge at 40% of the string, as on a violin

// instrument palette: wood tones shared by both themes
const WOOD = {
  plate: 0x8e4d26, // varnished spruce top
  plateSheen: 0xa65f2f, // lighter centre, suggests the arching
  edge: 0x1f1209, // dark outline around the top plate
  purfling: 0x2b1a0c,
  fhole: 0x140c06,
  board: 0x16120f, // ebony fingerboard
  boardSheen: 0x241d17,
  nut: 0x2a221b, // ebony like the board, only just distinguishable
  nutEdge: 0x554738, // faint warm line where the string breaks over it
  bridge: 0xddba8a, // maple
  bridgeTop: 0xecd9ae, // its top edge, caught by the raked view
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

    // straight-on and symmetric, like a luthier's portrait photograph; the
    // raked perspective is baked into the artwork (see BODY_SQUASH above)
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

  /** Violin top plate (upper/lower bouts, deep C-bout with protruding
   * corners, purfling inset from a dark edge), foreshortened below the
   * bridge line for the raked view (see warpY). The fingerboard overhangs
   * the top edge; the compressed lower bout runs toward the view's bottom. */
  private buildBody(): void {
    const zPlate = -0.3;

    const body = new THREE.Group();
    const bodyTopY = this.sToY(BODY_TOP_S);
    body.position.set(0, bodyTopY, 0);

    // scale the design outline so the bridge fraction lands exactly on the
    // string's end, then foreshorten everything below that line
    const yBridge = STRING_BOT - bodyTopY; // body-local bridge line
    const yScale = -yBridge / (BODY_LEN * BRIDGE_AT);
    const pts = dedupe(violinOutline().getPoints(12)).map(
      (p) => new THREE.Vector2(p.x, warpY(p.y * yScale, yBridge))
    );

    const plate = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts)), this.flat(WOOD.plate));
    plate.position.z = zPlate;
    body.add(plate);

    // subtle lighter centre: the outline offset well inward, suggesting the
    // arching of the top without any lighting (an inset, not a centroid
    // scale — scaling pokes outside the waist once the lower bout is
    // foreshortened)
    const centroid = pts
      .reduce((a, p) => a.add(p), new THREE.Vector2())
      .multiplyScalar(1 / pts.length);
    const sheen = new THREE.Mesh(
      new THREE.ShapeGeometry(new THREE.Shape(inset(pts, 0.15, centroid))),
      this.flat(WOOD.plateSheen, { opacity: 0.32 })
    );
    sheen.position.z = zPlate + 0.005;
    body.add(sheen);

    body.add(this.outline(pts, zPlate + 0.015, WOOD.edge, 2.4));
    body.add(this.outline(inset(pts, 0.055, centroid), zPlate + 0.01, WOOD.purfling, 1.2));

    // f-holes flanking the bridge, nicks level with its line
    for (const side of [-1, 1] as const) {
      const f = this.makeFHole();
      f.position.set(side * 0.415, STRING_BOT + 0.02 - bodyTopY, zPlate + 0.02);
      f.rotation.z = side * 0.16;
      f.scale.x = side;
      body.add(f);
    }

    this.instrument.add(body);
  }

  /** One f-hole (right-hand variant; mirror with scale.x = -1), after the
   * Stradivari pattern: a small round upper eye, a larger lower eye, a slim
   * S-curved stem flaring into wings at both ends, and the middle nicks. */
  private makeFHole(): THREE.Group {
    const mat = this.flat(WOOD.fhole);
    const g = new THREE.Group();

    const stem = new THREE.Shape();
    stem.moveTo(-0.108, 0.275); // upper wing, left of the top eye
    stem.bezierCurveTo(-0.09, 0.1, -0.01, -0.02, 0.048, -0.285);
    stem.lineTo(0.112, -0.27); // lower wing, above the bottom eye
    stem.bezierCurveTo(0.02, -0.02, -0.06, 0.08, -0.052, 0.283);
    stem.closePath();
    g.add(new THREE.Mesh(new THREE.ShapeGeometry(stem, 14), mat));

    const eyeT = new THREE.Mesh(new THREE.CircleGeometry(0.034, 20), mat);
    eyeT.position.set(-0.09, 0.295, 0);
    const eyeB = new THREE.Mesh(new THREE.CircleGeometry(0.052, 20), mat);
    eyeB.position.set(0.095, -0.3, 0);
    g.add(eyeT, eyeB);

    for (const [x0, dir] of [
      [-0.075, 1],
      [0.028, -1],
    ] as const) {
      const nick = new THREE.Shape();
      nick.moveTo(x0, 0.008);
      nick.lineTo(x0 + dir * 0.032, -0.01);
      nick.lineTo(x0, -0.028);
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

    // nut: ebony like the board (as on the real instrument), so it reads as
    // little more than a break line right at the top of the string — a finger
    // can stop all the way up to it (on it, the string is effectively open)
    const nut = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRect(0.4, 0.07, 0.02)),
      this.flat(WOOD.nut)
    );
    nut.position.set(0, STRING_TOP + 0.042, -0.02);
    const nutEdge = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.011), this.flat(WOOD.nutEdge));
    nutEdge.position.set(0, STRING_TOP + 0.008, -0.019);
    this.instrument.add(nut, nutEdge);
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
    // squashed for the raked view, crown peak carrying the string's end
    bridge.scale.y = BRIDGE_SQUASH;
    bridge.position.set(0, STRING_BOT - 0.02 * BRIDGE_SQUASH, -0.02);
    bridge.add(new THREE.Mesh(new THREE.ShapeGeometry(b, 10), this.flat(WOOD.bridge)));
    // the top edge of the bridge, visible from the raked viewpoint
    const top = new THREE.Shape();
    top.moveTo(-0.235, -0.07);
    top.quadraticCurveTo(0, 0.04, 0.235, -0.07);
    top.lineTo(0.235, -0.038);
    top.quadraticCurveTo(0, 0.075, -0.235, -0.038);
    top.closePath();
    const topMesh = new THREE.Mesh(new THREE.ShapeGeometry(top, 10), this.flat(WOOD.bridgeTop));
    topMesh.position.z = 0.003;
    bridge.add(topMesh);
    const bridgeLine = this.outline(dedupe(b.getPoints(8)), 0.005, WOOD.bridgeLine, 1.4);
    bridge.add(bridgeLine);
    this.instrument.add(bridge);

    // tailpiece below (squashed with the body), with the string's afterlength
    const t = new THREE.Shape();
    t.moveTo(-0.115, 0);
    t.quadraticCurveTo(0, 0.05, 0.115, 0);
    t.lineTo(0.185, -0.98);
    t.quadraticCurveTo(0.19, -1.13, 0, -1.14);
    t.quadraticCurveTo(-0.19, -1.13, -0.185, -0.98);
    t.closePath();
    const tail = new THREE.Mesh(new THREE.ShapeGeometry(t, 10), this.flat(WOOD.tailpiece));
    tail.scale.y = 0.72;
    tail.position.set(0, -1.916, -0.06);
    const ridge = new THREE.Shape();
    ridge.moveTo(-0.018, 0.01);
    ridge.lineTo(0.018, 0.01);
    ridge.lineTo(0.03, -1.02);
    ridge.lineTo(-0.03, -1.02);
    ridge.closePath();
    const ridgeMesh = new THREE.Mesh(new THREE.ShapeGeometry(ridge), this.flat(WOOD.tailSheen));
    ridgeMesh.scale.y = 0.72;
    ridgeMesh.position.set(0, -1.916, -0.055);

    // in front of the bridge face, as on a real violin seen from the front
    const afterMat = this.flat(0xffffff);
    this.stringTintMats.push(afterMat);
    const afterLen = new THREE.Mesh(new THREE.PlaneGeometry(0.016, 0.28), afterMat);
    afterLen.position.set(0, STRING_BOT - 0.13, -0.005);
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
 * as cubic segments [c1x, c1y, c2x, c2y, x, y], after the Stradivari
 * pattern: full, nearly level shoulders; the bout curves sweep *inward*
 * before each corner and a short flick juts back out, so the C-bout corners
 * protrude as real cornices do. */
const OUTLINE_HALF: number[][] = [
  [0.62, 0.004, 0.98, -0.15, 0.94, -0.72], // shoulder and upper bout
  [0.91, -1.06, 0.78, -1.26, 0.64, -1.36], // sweep in toward the upper corner
  [0.7, -1.385, 0.735, -1.42, 0.73, -1.48], // upper corner flick
  [0.46, -1.56, 0.45, -2.3, 0.74, -2.5], // C-bout waist to the lower corner
  [0.745, -2.53, 0.71, -2.58, 0.63, -2.61], // lower corner flick
  [0.96, -2.65, 1.16, -2.85, 1.15, -3.16], // out into the lower bout
  [1.13, -3.62, 0.7, -3.9, 0, -3.9], // round to the bottom centre
];

/** Foreshortening below the bridge line: identity above `yBridge`, then the
 * vertical scale eases from 1 down to LOWER_SQUASH over the ramp interval,
 * so the outline stays kink-free where the squash begins. */
function warpY(y: number, yBridge: number): number {
  if (y >= yBridge) return y;
  const d = yBridge - y;
  if (d <= SQUASH_RAMP0) return y;
  const ramp = SQUASH_RAMP1 - SQUASH_RAMP0;
  let compressed: number;
  if (d <= SQUASH_RAMP1) {
    // scale falls linearly across the ramp; integrate for the position
    const t = (d - SQUASH_RAMP0) / ramp;
    compressed = SQUASH_RAMP0 + (d - SQUASH_RAMP0) * (1 - ((1 - LOWER_SQUASH) * t) / 2);
  } else {
    const rampLen = ramp * (1 + LOWER_SQUASH) / 2;
    compressed = SQUASH_RAMP0 + rampLen + (d - SQUASH_RAMP1) * LOWER_SQUASH;
  }
  return yBridge - compressed;
}

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
