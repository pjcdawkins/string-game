/**
 * Three.js scene: four strings stretched vertically across the whole
 * viewport (G, D, A, E left to right — lanes IV..I, see ./lanes.ts), nut at
 * the top, bridge at the bottom, fingerboard behind the upper part. The
 * selected string is a live VisualString drawn at full contrast over the
 * three faint idle ones.
 * Provides an affine screen<->string mapping used by the input layer
 * (computed by projecting reference points, so it stays correct under any
 * camera/rotation).
 *
 * The instrument is drawn as a flat "vector illustration": layered
 * ShapeGeometry fills with crisp Line2 outlines, no lights and no lit
 * materials — deterministic on every GPU, cheap to render, and it reads
 * cleanly on both the light and dark themes (see ./theme.ts). The only
 * texture is a small canvas-generated varnish gradient baked onto the top
 * plate (radial shading, fine grain, a whisper of flame), still fully
 * deterministic. The artwork is fitted to the Le Brun Stradivarius of 1712
 * in the design harness `e2e/body-harness.mjs` — iterate shapes there, then
 * port; keep the geometry constants in the two files in sync.
 */
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { VisualString } from "./visualString";
import { makeTools, ToolSet, BOW_HAIR_SPAN } from "./tools";
import { FINGERBOARD_END, GuideMode, state } from "../state";
import { guideStops } from "../guides";
import { HARMONIC_NODES } from "../harmonics";
import { laneX, N_LANES, LANE_LINEWIDTH } from "./lanes";
import { currentTheme, onThemeChange, SceneTheme } from "./theme";
import { FHOLE_OUTLINE } from "./fholeOutline";

export const STRING_TOP = 2.1;
// the bottom end leaves room below for the bridge (and a glimpse of the
// belly) to stay visible above the bottom control panel, so you can see how
// close to it you bow
export const STRING_BOT = -1.62;
export const STRING_LEN = STRING_TOP - STRING_BOT;
export const BOARD_SURFACE_Z = -0.08;

// Fingerboard footprint, shared by the board fill and the guide lines ruled
// across it. Widths follow the reference photograph: ≈24 mm across at the
// nut and ≈42 mm at the bridge end (1 world unit ≈ 88 mm), so the board
// reads as slim as the real one against the body.
const BOARD_TOP_Y = STRING_TOP + 0.08; // the board starts a little above the nut
const BOARD_HALF_W_TOP = 0.137;
const BOARD_HALF_W_END = 0.24;

// Guide lines (☰ menu "Guides"): subtle fret-like markers on the board only,
// visual analogues of a learner's finger tapes. Light gray, faint enough to
// sit in the default view without shouting — the ebony stays ebony.
const GUIDE_COLOR = 0xbdbdbd;
const GUIDE_OPACITY = 0.3;

// The bow is drawn at the true proportion of a full-size bow to a full-size
// violin: a violin's speaking string is ~328 mm and a bow's playing hair
// ~650 mm, so the hair is very nearly 2× the string length. STRING_LEN is that
// speaking length in world units, so a full-size bow's hair is BOW_HAIR_RATIO ×
// STRING_LEN wide (see SceneView.applyBowScale). On a viewport too narrow to
// fit that, the whole bow scales down to fit — but never below its own base
// geometry size (BOW_HAIR_SPAN), which already overflows a phone screen and
// reads well there. The stroke *duration* is held constant across viewports
// (see interactions.ts); only the bow's visible size and world speed change.
const BOW_HAIR_RATIO = 2.0;
const BOW_FIT = 0.94; // fraction of the viewport width a full-size bow may fill

// On a small screen the camera zooms in on the playable string — the stretch
// from the nut down to the bridge — cropping the wide body flanks and the belly
// below the bridge so the string reads as large as the screen allows. Larger
// screens keep the fuller portrait framing (zoom 1, centred on the origin). The
// screen<->string mapping and the bow scale are both derived from the live
// camera, so they follow the zoom automatically (see updateMapping /
// applyBowScale). Mirrors the CSS narrow breakpoint in src/style.css.
const SMALL_SCREEN_MAX = 600; // px viewport width
const FRAME_TOP = 2.22; // world-y kept in view at the top (nut + board end)
const FRAME_BOT = -1.7; // world-y kept in view at the bottom (below the bridge)
const FRAME_HALF_W = 0.5; // world-x half-width kept in view (strings + finger reach)

// The body is drawn in true proportions (an earlier below-bridge
// foreshortening made the violin read as squashed) — the viewport simply
// crops the lower bout. Only the bridge is drawn raked: squashed with its
// top edge showing, as if seen from slightly above. A real camera tilt
// would make the screen<->string mapping non-affine and cost pointer
// accuracy on the fingerboard.
// The bridge stands perpendicular to the belly, so face-on it would be seen
// almost edge-on. We rake it — draw it as if looked down on from above — so
// its carving reads. A strong rake (small squash) matches the reference: the
// bridge is a shallow maple band, its front face (and the heart) mostly
// foreshortened away, seen nearly from the top.
const BRIDGE_SQUASH = 0.15;
// The bridge's natural break point sits at STRING_BOT (s = 1), which lands its
// base below the f-hole lower eyes. Lift the whole bridge (and its break line)
// so the base rises to the lower-eye height. Purely visual: STRING_BOT and the
// s<->y mapping are untouched (fingering and pitch are unaffected); the string
// breaks over the lifted crown and the afterlength runs on to the tail. The
// bow's bridge-side limit is derived from this rise (see BOW_MAX) so the hair
// stops at the lifted crown, not down at STRING_BOT.
export const BRIDGE_RISE = 0.082;
const BODY_LEN = 3.9; // outline design length (see OUTLINE_HALF)
const BRIDGE_AT = 0.54; // bridge at 54% of the body, as measured on the photo
const BODY_TOP_S = 0.4; // body top edge at 40% of the string, as on a violin
const PURFLING_INSET = 0.048; // purfling inset from the outline, design units

/** World y where a string at lateral offset `x` breaks over the bridge: the
 * crest of the bridge's raked top edge at that x. The crown falls away toward
 * the ears, so the outer strings break slightly lower than the middle ones —
 * matching the curve drawn in buildBridge(). */
function bridgeBreakY(x: number): number {
  const t = (x / 0.235 + 1) / 2; // parameter along the top-edge quadratic
  const local = -0.038 + 2 * t * (1 - t) * 0.113;
  return STRING_BOT + BRIDGE_RISE + (local - 0.02) * BRIDGE_SQUASH;
}

// Afterlength: below the bridge the strings fan in again toward the
// tailpiece, which hangs below the bottom of the view (the vertical FOV
// puts the viewport edge at y ≈ -2.33), so the lines simply run off-screen
// aimed at it. TAIL_GAP is the lane spacing at the lines' (off-screen) end:
// the nut spacing, since the strings never sit closer together than at the
// nut — everything visible stays wider than that.
const TAIL_Y = STRING_BOT - 0.78;
const TAIL_GAP = 0.062;

function tailX(idx: number): number {
  return (idx - 1.5) * TAIL_GAP;
}

// instrument palette: wood tones shared by both themes, matched to the
// golden-amber varnish of the Le Brun Strad reference.
const WOOD = {
  edge: 0x241206, // dark outline around the top plate
  rim: 0xcf9a52, // the rounded edge overhang catching the light
  purfling: 0x2b190a,
  fhole: 0x120a04,
  board: 0x16120f, // ebony fingerboard
  nut: 0x2a221b, // ebony like the board, only just distinguishable
  nutEdge: 0x554738, // faint warm line where the string breaks over it
  bridgeTop: 0xecd9ae, // the bridge's top edge, caught by the raked view
  bridgeLine: 0x6b4826,
  bridgeHi: 0xe8caa0, // maple, crown of the bridge…
  bridgeLo: 0xd0a878, // …shading down to its feet
};

// varnish gradient (baked into the plate texture): centre out to the edges
const VARNISH_STOPS: [number, string][] = [
  [0, "#c47829"],
  [0.5, "#a85c22"],
  [0.85, "#86451a"],
  [1, "#6e3714"],
];

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene = new THREE.Scene();
  readonly instrument = new THREE.Group();
  readonly visual: VisualString;
  readonly tools: ToolSet;

  // Uniform scale currently applied to the bow mesh (1 = base geometry size).
  // Recomputed on resize from the viewport; read by the input/render layers to
  // convert the normalised bow-travel coordinate into world units.
  bowMeshScale = 1;

  private nodeMarkers = new THREE.Group();
  // fret-like guide lines across the board: 1-px hairlines (LineBasicMaterial
  // ignores linewidth everywhere that matters), one LineSegments draw call
  private guideLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: GUIDE_COLOR,
      transparent: true,
      opacity: GUIDE_OPACITY,
      depthWrite: false,
    })
  );
  private guideMode: GuideMode | null = null;
  private fingerContact: THREE.Mesh;
  private fatLineMats: LineMaterial[] = [];
  // the four strings at rest, one per lane; the selected lane's idle line is
  // hidden and the live VisualString vibrates over the others in its place
  private idleStrings: Line2[] = [];
  private idleStringMats: LineMaterial[] = [];
  private afterLength!: Line2; // the selected string below the bridge
  private activeString = -1;

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
    this.setActiveString(state.stringIdx);
    this.tools = makeTools(this.instrument);

    this.fingerContact = new THREE.Mesh(
      // sized with the finger circle in tools.ts: within one string lane
      new THREE.CircleGeometry(0.05, 24),
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
    for (const m of this.idleStringMats) {
      m.color.set(t.string);
      m.opacity = t.idleStringOpacity;
    }
    (this.afterLength.material as LineMaterial).color.set(t.string);
    const fc = this.fingerContact.material as THREE.MeshBasicMaterial;
    fc.blending = t.additiveGlow ? THREE.AdditiveBlending : THREE.NormalBlending;
    fc.needsUpdate = true;
  }

  private flat(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  }

  /** A crisp screen-space outline through `pts` (closed), at depth `z`. */
  private outline(pts: THREE.Vector2[], z: number, color: number, px: number, opacity = 1): Line2 {
    const pos: number[] = [];
    for (const p of pts) pos.push(p.x, p.y, z);
    pos.push(pts[0].x, pts[0].y, z);
    const geo = new LineGeometry();
    geo.setPositions(pos);
    const mat = new LineMaterial({ color, linewidth: px, worldUnits: false });
    if (opacity < 1) {
      mat.transparent = true;
      mat.opacity = opacity;
      mat.depthWrite = false;
    }
    this.fatLineMats.push(mat);
    return new Line2(geo, mat);
  }

  private buildFurniture(): void {
    this.buildBody();
    this.buildBoardAndNut();
    this.buildBridge();
    this.buildStrings();
    this.buildNodeMarkers();
    // guide lines lie flat on the board, under the strings and every marker;
    // setGuides() fills the geometry in when a mode is first selected
    this.guideLines.position.z = BOARD_SURFACE_Z - 0.005;
    this.guideLines.visible = false;
    this.instrument.add(this.guideLines);
  }

  /** The four strings at rest: faint polylines, one per lane, fanning out
   * from the nut to their break point on the bridge crown and back in below
   * it, down to the out-of-view tailpiece. Drawn just in front of the
   * bridge, as the strings pass over it. */
  private buildStrings(): void {
    for (let i = 0; i < N_LANES; i++) {
      const xBridge = laneX(i, 1);
      const geo = new LineGeometry();
      geo.setPositions([
        laneX(i, 0), STRING_TOP, -0.01,
        xBridge, bridgeBreakY(xBridge), -0.01,
        tailX(i), TAIL_Y, -0.01,
      ]);
      const mat = new LineMaterial({
        color: 0xffffff, // themed in applyTheme
        linewidth: LANE_LINEWIDTH[i],
        worldUnits: false,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      });
      this.fatLineMats.push(mat);
      this.idleStringMats.push(mat);
      const line = new Line2(geo, mat);
      this.idleStrings.push(line);
      this.instrument.add(line);
    }

    // the selected string's own afterlength (its idle polyline is hidden,
    // and the live VisualString stops at the bridge, where it is pinned)
    this.afterLength = new Line2(
      new LineGeometry(),
      new LineMaterial({ color: 0xffffff, linewidth: 2.6, worldUnits: false })
    );
    this.fatLineMats.push(this.afterLength.material as LineMaterial);
    this.instrument.add(this.afterLength);
  }

  /** Select the sounding string: the live VisualString moves onto its lane
   * (vibrating over the idle neighbours) and that lane's idle line hides,
   * while its full-contrast afterlength keeps the string continuing over
   * the bridge toward the tailpiece. */
  setActiveString(idx: number): void {
    if (idx === this.activeString) return;
    this.activeString = idx;
    this.idleStrings.forEach((l, i) => (l.visible = i !== idx));
    const xBridge = laneX(idx, 1);
    this.visual.setLane(idx, bridgeBreakY(xBridge));
    this.afterLength.geometry.setPositions([
      xBridge, bridgeBreakY(xBridge), -0.005,
      tailX(idx), TAIL_Y, -0.005,
    ]);
    (this.afterLength.material as LineMaterial).linewidth = LANE_LINEWIDTH[idx];
    this.nodeBase = -1; // re-seat the harmonic markers onto the new lane
  }

  /** Lateral world-x of the active string at position `s` along it. */
  activeLaneX(s: number): number {
    return laneX(this.activeString, s);
  }

  /** Violin top plate (upper/lower bouts, deep C-bout with protruding
   * corners, purfling inset from a dark edge, varnish gradient baked into a
   * canvas texture) in true proportions, fitted to the Le Brun Strad. The
   * fingerboard overhangs the top edge; the lower bout runs off the bottom
   * of the view. */
  private buildBody(): void {
    const zPlate = -0.3;

    const body = new THREE.Group();
    const bodyTopY = this.sToY(BODY_TOP_S);
    body.position.set(0, bodyTopY, 0);

    // scale the design outline so the bridge fraction of the body lands
    // exactly on the string's end
    const yScale = (bodyTopY - STRING_BOT) / (BODY_LEN * BRIDGE_AT);
    const pts = dedupe(violinOutline().getPoints(12)).map(
      (p) => new THREE.Vector2(p.x, p.y * yScale)
    );

    const plateGeo = new THREE.ShapeGeometry(new THREE.Shape(pts));
    // map the varnish texture over the plate's bounding box
    plateGeo.computeBoundingBox();
    const bb = plateGeo.boundingBox!;
    const uv = plateGeo.attributes.uv as THREE.BufferAttribute;
    const posA = plateGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        (posA.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
        (posA.getY(i) - bb.min.y) / (bb.max.y - bb.min.y)
      );
    }
    const plate = new THREE.Mesh(
      plateGeo,
      new THREE.MeshBasicMaterial({ map: varnishTexture(), side: THREE.DoubleSide })
    );
    plate.position.z = zPlate;
    body.add(plate);

    body.add(this.outline(pts, zPlate + 0.015, WOOD.edge, 2.4));
    // the rounded edge overhang catches the light between edge and purfling
    body.add(this.outline(offsetLoop(0.022, yScale), zPlate + 0.01, WOOD.rim, 1.3, 0.5));
    body.add(this.outline(offsetLoop(PURFLING_INSET, yScale), zPlate + 0.012, WOOD.purfling, 1.4));

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

  /** One f-hole (right-hand variant; mirror with scale.x = -1): the real
   * openclipart "Violin f hole" vector, fitted to the Le Brun Strad. It is a
   * single filled path (the eyes are the solid rounded ends of the slot), so
   * it draws as one shape — see FHOLE_OUTLINE / scripts/fit-svg-fhole.mjs. */
  private makeFHole(): THREE.Group {
    const g = new THREE.Group();
    const shape = new THREE.Shape(FHOLE_OUTLINE.map(([x, y]) => new THREE.Vector2(x, y)));
    g.add(new THREE.Mesh(new THREE.ShapeGeometry(shape), this.flat(WOOD.fhole)));
    return g;
  }

  /** Fingerboard (tapered, rounded end — a single flat ebony fill, sized by
   * the BOARD_* constants above) and nut. */
  private buildBoardAndNut(): void {
    const boardTopY = BOARD_TOP_Y;
    const boardEndY = this.sToY(FINGERBOARD_END);

    const bs = new THREE.Shape();
    bs.moveTo(-BOARD_HALF_W_TOP, boardTopY);
    bs.lineTo(BOARD_HALF_W_TOP, boardTopY);
    // the end is a nearly straight horizontal edge (a real board's end is
    // squared off, not the strongly convex arc it had before) with only the
    // faintest sag in the middle
    bs.lineTo(BOARD_HALF_W_END, boardEndY);
    bs.quadraticCurveTo(0, boardEndY - 0.015, -BOARD_HALF_W_END, boardEndY);
    bs.closePath();
    const board = new THREE.Mesh(new THREE.ShapeGeometry(bs, 10), this.flat(WOOD.board));
    board.position.z = BOARD_SURFACE_Z - 0.01;
    this.instrument.add(board);

    // nut: ebony like the board (as on the real instrument), so it reads as
    // little more than a break line right at the top of the string — a finger
    // can stop all the way up to it (on it, the string is effectively open)
    const nut = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRect(0.3, 0.07, 0.02)),
      this.flat(WOOD.nut)
    );
    nut.position.set(0, STRING_TOP + 0.042, -0.02);
    const nutEdge = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.011), this.flat(WOOD.nutEdge));
    nutEdge.position.set(0, STRING_TOP + 0.008, -0.019);
    this.instrument.add(nut, nutEdge);
  }

  /** Maple bridge carrying the string's end, with its traditional carving:
   * curled ears, deep waist notches, splayed legs around a high arch, a
   * heart (lobes up, apex down) and slim comma kidneys tilted toward the
   * ears — all cut through as holes. No tailpiece — the picture stops at
   * the playable string, and below the bridge only a glimpse of the belly
   * remains. The crown quadratic is load-bearing: bridgeBreakY() mirrors it. */
  private buildBridge(): void {
    const b = new THREE.Shape();
    b.moveTo(-0.235, -0.07);
    b.quadraticCurveTo(0, 0.04, 0.235, -0.07); // crown
    b.quadraticCurveTo(0.272, -0.085, 0.258, -0.12); // ear, curling under
    b.quadraticCurveTo(0.21, -0.148, 0.208, -0.19); // waist notch, a deep half-round
    b.quadraticCurveTo(0.207, -0.23, 0.256, -0.255); // flaring back out to the leg
    b.lineTo(0.29, -0.307);
    b.quadraticCurveTo(0.3, -0.327, 0.28, -0.335); // foot
    b.lineTo(0.13, -0.335);
    b.quadraticCurveTo(0.1, -0.335, 0.095, -0.28); // inside of the leg
    b.quadraticCurveTo(0, -0.09, -0.095, -0.28); // arch between the feet
    b.quadraticCurveTo(-0.1, -0.335, -0.13, -0.335);
    b.lineTo(-0.28, -0.335);
    b.quadraticCurveTo(-0.3, -0.327, -0.29, -0.307);
    b.lineTo(-0.256, -0.255);
    b.quadraticCurveTo(-0.207, -0.23, -0.208, -0.19);
    b.quadraticCurveTo(-0.21, -0.148, -0.258, -0.12);
    b.quadraticCurveTo(-0.272, -0.085, -0.235, -0.07);
    b.closePath();
    b.holes.push(bridgeHeart(), bridgeKidney(1), bridgeKidney(-1));

    const geo = new THREE.ShapeGeometry(b, 10);
    // vertical maple gradient, baked as vertex colours (crown light, feet deep)
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const hi = new THREE.Color(WOOD.bridgeHi);
    const lo = new THREE.Color(WOOD.bridgeLo);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = (0.04 - pos.getY(i)) / 0.375; // 0 at the crown peak, 1 at the feet
      c.lerpColors(hi, lo, Math.min(1, Math.max(0, t)));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const bridge = new THREE.Group();
    // squashed for the raked view, crown peak carrying the string's end
    bridge.scale.y = BRIDGE_SQUASH;
    bridge.position.set(0, STRING_BOT + BRIDGE_RISE - 0.02 * BRIDGE_SQUASH, -0.02);
    bridge.add(
      new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
    );
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
  }

  private buildNodeMarkers(): void {
    // natural-harmonic node markers: the shared node set (harmonics.ts) also
    // feeds the Touch-mode snap, so a dot and a snap target can never drift
    for (const { p, n } of HARMONIC_NODES) {
      const c = new THREE.Color().setHSL(0.52 + (n - 2) * 0.07, 0.8, 0.6);
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.035, 20),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85 })
      );
      dot.userData.p = p;
      dot.position.set(0, this.sToY(p), 0.02);
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
      // beads sitting on the string itself: touch the dot, get the harmonic.
      // They run the whole vibrating length — nut (or stop) to bridge — since
      // the string can be touched past the fingerboard's end too.
      const abs = stop + p * (1 - stop);
      d.position.x = laneX(this.activeString, abs);
      d.position.y = this.sToY(abs);
    }
  }

  sToY(s: number): number {
    return STRING_TOP - s * STRING_LEN;
  }

  setNodeMarkersVisible(visible: boolean): void {
    this.nodeMarkers.visible = visible;
  }

  /** Show the guide scale as faint full-width lines across the fingerboard
   * (☰ menu "Guides"). Each line sits at a degree's acoustic stop — where the
   * note speaks, like a fret or a learner's tape — from the shared scale in
   * guides.ts, so a line and its snap target can never drift. The guides are
   * the same for every string (degrees are fractions of the speaking length,
   * whatever the open pitch) and stay rooted on the nut regardless of any
   * stop, so the geometry only rebuilds when the mode changes. */
  setGuides(mode: GuideMode): void {
    if (mode === this.guideMode) return;
    this.guideMode = mode;
    this.guideLines.visible = mode !== "off";
    if (mode === "off") return;
    const boardEndY = this.sToY(FINGERBOARD_END);
    const pos: number[] = [];
    for (const stop of guideStops(mode)) {
      const y = this.sToY(stop);
      // full width of the tapering board at this height
      const hw =
        BOARD_HALF_W_TOP +
        ((BOARD_HALF_W_END - BOARD_HALF_W_TOP) * (BOARD_TOP_Y - y)) / (BOARD_TOP_Y - boardEndY);
      pos.push(-hw, y, 0, hw, y, 0);
    }
    this.guideLines.geometry.dispose();
    this.guideLines.geometry = new THREE.BufferGeometry();
    this.guideLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  }

  showFingerContact(s: number, strength: number): void {
    const mat = this.fingerContact.material as THREE.MeshBasicMaterial;
    mat.opacity = strength * 0.55;
    this.fingerContact.position.x = laneX(this.activeString, s);
    this.fingerContact.position.y = this.sToY(s);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyZoom();
    this.visual.setResolution(w, h);
    for (const m of this.fatLineMats) m.resolution.set(w, h);
    this.applyBowScale();
    this.updateMapping();
  }

  /** Half the world-height visible at z = 0 with zoom 1: the perspective
   * frustum's half-height at the instrument plane. The zoom framing and the
   * bow fit both derive from this, so it lives in one place. */
  private baseHalfHeight(): number {
    return Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.position.z;
  }

  /** Zoom + recentre the camera to fill a small screen with the playable
   * string (nut to bridge); larger screens keep the default framing. Updates
   * the projection so the derived mapping/bow scale pick the change up. */
  private applyZoom(): void {
    const halfHBase = this.baseHalfHeight();
    if (window.innerWidth <= SMALL_SCREEN_MAX) {
      const halfWBase = halfHBase * this.camera.aspect;
      const zoomV = halfHBase / ((FRAME_TOP - FRAME_BOT) / 2);
      const zoomH = halfWBase / FRAME_HALF_W;
      // the tighter of the two fits, so the whole region stays in view; never
      // below 1, so we only ever zoom in from the default framing
      this.camera.zoom = Math.max(1, Math.min(zoomV, zoomH));
      this.camera.position.y = (FRAME_TOP + FRAME_BOT) / 2;
    } else {
      this.camera.zoom = 1;
      this.camera.position.y = 0;
    }
    this.camera.updateProjectionMatrix();
  }

  /** Size the bow to the true bow:violin ratio when there is room, scaling it
   * down to fit a narrow viewport (but never below its base geometry, which
   * already overflows a phone and reads well there). */
  private applyBowScale(): void {
    const halfH = this.baseHalfHeight() / this.camera.zoom;
    const viewWidth = 2 * halfH * this.camera.aspect; // world units visible at z = 0
    const hairFull = BOW_HAIR_RATIO * STRING_LEN; // full-size bow hair
    const hairLen = Math.max(BOW_HAIR_SPAN, Math.min(hairFull, viewWidth * BOW_FIT));
    this.bowMeshScale = hairLen / BOW_HAIR_SPAN;
    this.tools.bow.scale.set(this.bowMeshScale, this.bowMeshScale, 1);
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
 * as cubic segments [c1x, c1y, c2x, c2y, x, y], with L = 3.9. Fitted in the
 * SVG harness (e2e/body-harness.mjs) to an edge-scanned width profile of the
 * Le Brun Stradivarius of 1712: full square-ish shoulders that stay
 * tangent-continuous, upper bout widest 0.933 at 0.17 L, upper corner tips
 * 0.868 at 0.34 L, waist 0.616 around 0.42 L, lower corner tips 1.03 at
 * 0.58 L, lower bout widest 1.178 at 0.79 L, and a broad bottom. The bout
 * flanks dip slightly before running into the corner tips; the deep
 * concavity and the curls under the tips are on the C-side, so the cornices
 * overhang and read as points. */
const OUTLINE_HALF: number[][] = [
  [0.15, -0.001, 0.3, -0.006, 0.44, -0.018], // top edge, nearly flat past the neck
  [0.72, -0.03, 0.933, -0.28, 0.933, -0.68], // full square-ish shoulder, smoothly rounded
  [0.92, -0.9, 0.81, -1.1, 0.868, -1.34], // flank with a slight dip, out to the corner tip
  [0.77, -1.348, 0.71, -1.36, 0.655, -1.425], // concave curl under the corner
  [0.617, -1.5, 0.613, -1.72, 0.638, -1.88], // C-bout through the waist
  [0.66, -2.0, 0.75, -2.22, 1.03, -2.26], // C-bout flaring to the lower corner tip
  [0.995, -2.3, 0.99, -2.37, 1.0, -2.44], // concave curl under the lower corner
  [1.02, -2.56, 1.178, -2.85, 1.178, -3.09], // lower bout out to the widest
  [1.178, -3.32, 1.06, -3.56, 0.95, -3.68], // lower bout, broad
  [0.88, -3.79, 0.63, -3.9, 0, -3.9], // bottom
];

type P2 = [number, number];

function cubicAt(p0: P2, c1: P2, c2: P2, p3: P2, t: number): P2 {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
  ];
}

function cubicTanAt(p0: P2, c1: P2, c2: P2, p3: P2, t: number): P2 {
  const u = 1 - t;
  return [
    3 * u * u * (c1[0] - p0[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]),
    3 * u * u * (c1[1] - p0[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]),
  ];
}

/** Sample the full closed outline (right half + mirrored left half),
 * y-scaled by `yScale`, returning points and unit tangents in path order. */
function sampleOutline(yScale: number, perSeg = 28): { pts: P2[]; tans: P2[] } {
  const segs: [P2, P2, P2, P2][] = [];
  let prev: P2 = [0, 0];
  for (const [c1x, c1y, c2x, c2y, x, y] of OUTLINE_HALF) {
    segs.push([prev, [c1x, c1y], [c2x, c2y], [x, y]]);
    prev = [x, y];
  }
  for (let i = OUTLINE_HALF.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = OUTLINE_HALF[i];
    const [ex, ey] = i === 0 ? [0, 0] : [OUTLINE_HALF[i - 1][4], OUTLINE_HALF[i - 1][5]];
    segs.push([prev, [-c2x, c2y], [-c1x, c1y], [-ex, ey]]);
    prev = [-ex, ey];
  }
  const pts: P2[] = [],
    tans: P2[] = [];
  for (const [p0, c1, c2, p3] of segs) {
    for (let i = 0; i < perSeg; i++) {
      const t = i / perSeg;
      const p = cubicAt(p0, c1, c2, p3, t);
      const tn = cubicTanAt(p0, c1, c2, p3, t);
      const ty = tn[1] * yScale;
      const n = Math.hypot(tn[0], ty) || 1;
      pts.push([p[0], p[1] * yScale]);
      tans.push([tn[0] / n, ty / n]);
    }
  }
  return { pts, tans };
}

function segIntersect(a: P2, b: P2, c: P2, d: P2): P2 | null {
  const rx = b[0] - a[0],
    ry = b[1] - a[1];
  const sx = d[0] - c[0],
    sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** Inward offset of the closed outline by `d` (in the y-scaled body frame),
 * with the self-intersection loops that appear at the sharp corner tips
 * clipped out, so the purfling mitres to a clean point toward each corner
 * and otherwise simply follows the curve. */
function offsetLoop(d: number, yScale: number): THREE.Vector2[] {
  const { pts, tans } = sampleOutline(yScale);
  // the path runs clockwise (y-up frame), so inward is the right-hand normal
  let off: P2[] = pts.map((p, i) => [p[0] + tans[i][1] * d, p[1] - tans[i][0] * d]);
  const maxLoop = Math.floor(off.length / 6);
  let cut = true;
  while (cut) {
    cut = false;
    outer: for (let i = 0; i < off.length; i++) {
      for (let k = 2; k <= maxLoop; k++) {
        const j = (i + k) % off.length;
        const x = segIntersect(off[i], off[(i + 1) % off.length], off[j], off[(j + 1) % off.length]);
        if (x) {
          if (j > i) off = [...off.slice(0, i + 1), x, ...off.slice(j + 1)];
          else off = [...off.slice(j + 1, i + 1), x];
          cut = true;
          break outer;
        }
      }
    }
  }
  return off.map((p) => new THREE.Vector2(p[0], p[1]));
}

// --------------------------------------------------------------------------
// Bridge cutouts (fitted in e2e/body-harness.mjs — keep in sync).

/** Heart cutout, lobes up, apex down, centred on (0, cy). */
function bridgeHeart(cy = -0.155, w = 0.058, h = 0.082): THREE.Path {
  const x = w / 2,
    top = cy + h * 0.42,
    apex = cy - h * 0.58;
  const p = new THREE.Path();
  p.moveTo(0, cy + h * 0.1);
  p.bezierCurveTo(0.004, top + 0.012, x * 0.55, top + 0.01, x * 0.8, top);
  p.bezierCurveTo(x * 1.15, top - 0.016, x, cy - h * 0.1, 0, apex);
  p.bezierCurveTo(-x, cy - h * 0.1, -x * 1.15, top - 0.016, -x * 0.8, top);
  p.bezierCurveTo(-x * 0.55, top + 0.01, -0.004, top + 0.012, 0, cy + h * 0.1);
  p.closePath();
  return p;
}

/** Kidney cutout (a slim comma, outer end raised toward the ear), side = ±1. */
function bridgeKidney(side: number, cx = 0.132, cy = -0.142, tilt = 0.55, size = 1.18): THREE.Path {
  const cos = Math.cos(tilt) * size,
    sin = Math.sin(tilt) * size;
  // local coords: long axis x (outward), rounded fat outer end, tapered inner
  const m = (x: number, y: number): [number, number] => [
    side * (cx + x * cos - y * sin),
    cy + x * sin + y * cos,
  ];
  const p = new THREE.Path();
  p.moveTo(...m(-0.038, 0.002));
  p.bezierCurveTo(...m(-0.032, 0.016), ...m(-0.005, 0.02), ...m(0.016, 0.016));
  p.bezierCurveTo(...m(0.037, 0.011), ...m(0.038, -0.013), ...m(0.02, -0.018));
  p.bezierCurveTo(...m(0.0, -0.023), ...m(-0.026, -0.016), ...m(-0.036, -0.007));
  p.bezierCurveTo(...m(-0.041, -0.003), ...m(-0.041, -0.001), ...m(-0.038, 0.002));
  p.closePath();
  return p;
}

// --------------------------------------------------------------------------
// Varnish: the top plate's fill, baked once into a small canvas texture —
// a radial golden-amber gradient (lighter around the bridge, darker toward
// the edges), fine vertical spruce grain, and a whisper of horizontal flame.
// Deterministic (no randomness, no image assets) and cheap: 256×512 px.
function varnishTexture(): THREE.CanvasTexture {
  const W = 512,
    H = 1024;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;

  const rad = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, 0.8 * Math.hypot(W, H) / Math.SQRT2);
  for (const [o, c] of VARNISH_STOPS) rad.addColorStop(o, c);
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, W, H);

  // flame: soft horizontal bands, a triangle wave of faint light and dark
  const flame = ctx.createLinearGradient(0, 0, 0, H);
  const period = 32 / H; // ≈ 0.13 design units
  for (let o = 0; o <= 1.0001; o += period) {
    const mid = Math.min(1, o + period / 2);
    flame.addColorStop(Math.min(1, o), "rgba(255,255,255,0.02)");
    flame.addColorStop(mid, "rgba(0,0,0,0.015)");
  }
  ctx.fillStyle = flame;
  ctx.fillRect(0, 0, W, H);

  // grain: fine vertical lines
  ctx.fillStyle = "rgba(0,0,0,0.035)";
  for (let x = 4; x < W; x += 8) ctx.fillRect(x, 0, 1, H);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
