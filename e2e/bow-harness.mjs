/**
 * Standalone bow design harness: renders the bow artwork — stick, head, frog,
 * hair — as SVG at large scale, with a zoom panel of the head so its profile
 * can be compared against a reference photograph of a Tourte-style swan head.
 * Iterating here gives much faster feedback than rebuilding the app: edit the
 * shapes, re-run, look at the PNG.
 *
 *   node e2e/bow-harness.mjs [out.png]
 *
 * The geometry below (HEAD_* segments, face plate, frog, hair extents) is the
 * design source that src/scene/tools.ts ports — keep the two in sync.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BOW = {
  stick: "#8a5228",
  hair: "#efe7d2",
  hairEdge: "#9d947c",
  frog: "#17110d",
  pearl: "#ccd6df",
  silver: "#b3bac2",
  grip: "#3c2b1f",
  tipPlate: "#e9e0cc",
};

// ---------------------------------------------------------------------------
// Stick + head outline: quadratic segments [cx, cy, x, y] from START, y up,
// frog end +x, tip -x, hair line at y = 0. Mirrors the THREE.Shape in
// src/scene/tools.ts one-to-one (same command order, same numbers).
const START = [1.58, 0.114];
const STICK_TOP = [
  [1.3, 0.092, 0.7, 0.064],
  [0.05, 0.054, -0.6, 0.06],
  [-1.08, 0.066, -1.56, 0.088], // out to the head, staying slim to the ridge
];
// the head, side on (see tools.ts for the prose description)
const HEAD = [
  [-1.585, 0.094, -1.607, 0.0975], // top, rising gently off the stick
  [-1.63, 0.101, -1.641, 0.099], // to the crest's soft front corner
  [-1.6635, 0.0635, -1.6815, 0.031], // face: one long forward-leaning line
  [-1.6935, 0.0135, -1.7005, 0.009], // into the beak
  [-1.7035, 0.007, -1.699, 0.0055], // the beak's tip, wrapping under
  [-1.6655, 0.004, -1.634, 0.002], // underside, sloping ~-3° down to the hair
  [-1.62, 0.013, -1.611, 0.036], // throat, rising steeply from the mortise
  [-1.6, 0.06, -1.564, 0.067], // the scoop sweeping back under the stick
];
const STICK_BOTTOM = [
  [-1.05, 0.054, -0.6, 0.044],
  [0.05, 0.04, 0.7, 0.05],
  [1.3, 0.076, 1.58, 0.096],
];

function facePlateSegs(kind) {
  // the plate covers only the beak: a wedge whose outer edge is the head
  // outline (down the beak's front, around the tip, along the underside to
  // the mortise) and whose inner edge is one clean diagonal joint line back
  // up to the beak's top on the face. The liner is the same wedge a hair
  // taller, so the joint reads as a thin dark seam.
  const outer = [
    [-1.6935, 0.0135, -1.7005, 0.009], // outer edge: the beak's own front line
    [-1.7035, 0.007, -1.699, 0.0055], // (exactly the head outline: the tip...
    [-1.6655, 0.004, -1.634, 0.002], // ...then the underside to the mortise)
  ];
  if (kind === "liner")
    return {
      start: [-1.6803, 0.0332], // a hair up the face from the plate's corner
      segs: [
        ["L", -1.6815, 0.031],
        ...outer,
        ["L", -1.636, 0.0105], // cut end at the mortise
        [-1.6625, 0.018, -1.6803, 0.0332], // joint line, back up to the face
      ],
    };
  return {
    start: [-1.6815, 0.031],
    segs: [
      ...outer,
      ["L", -1.636, 0.0085], // the cut end where the hair enters
      [-1.664, 0.0155, -1.6815, 0.031], // joint line, back up to the beak's top
    ],
  };
}

const HAIR = { edge: [2.9, 0.024], ribbon: [2.888, 0.014], cx: -0.189 };

// ---------------------------------------------------------------------------
// SVG assembly.

/** Affine panel transform: design [x,y] (y up) -> "px,py" string. */
function panel(ox, oy, s) {
  return (p) => `${(ox + p[0] * s).toFixed(2)},${(oy - p[1] * s).toFixed(2)}`;
}

function quadPathD(T, start, segs, close = true) {
  let d = `M ${T(start)}`;
  for (const seg of segs) {
    if (seg[0] === "L") d += ` L ${T([seg[1], seg[2]])}`;
    else d += ` Q ${T([seg[0], seg[1]])} ${T([seg[2], seg[3]])}`;
  }
  return d + (close ? " Z" : "");
}

function stickHeadD(T) {
  return quadPathD(T, START, [...STICK_TOP, ...HEAD, ...STICK_BOTTOM]);
}

function bowGroup(T) {
  let g = "";
  // hair
  const [ew, eh] = HAIR.edge;
  const [rw, rh] = HAIR.ribbon;
  const e0 = T([HAIR.cx - ew / 2, eh / 2]).split(",");
  g += `<rect x="${e0[0]}" y="${e0[1]}" width="${(T([HAIR.cx + ew / 2, 0]).split(",")[0] - e0[0]).toFixed(2)}" height="${(eh * S(T)).toFixed(2)}" fill="${BOW.hairEdge}"/>`;
  const r0 = T([HAIR.cx - rw / 2, rh / 2]).split(",");
  g += `<rect x="${r0[0]}" y="${r0[1]}" width="${(rw * S(T)).toFixed(2)}" height="${(rh * S(T)).toFixed(2)}" fill="${BOW.hair}"/>`;
  // stick + head
  g += `<path d="${stickHeadD(T)}" fill="${BOW.stick}"/>`;
  // tip liner + plate
  const liner = facePlateSegs("liner");
  g += `<path d="${quadPathD(T, liner.start, liner.segs)}" fill="${BOW.frog}"/>`;
  const plate = facePlateSegs("plate");
  g += `<path d="${quadPathD(T, plate.start, plate.segs)}" fill="${BOW.tipPlate}"/>`;
  // frog (fixed, not under iteration — drawn for context)
  g += `<path d="${quadPathD(T, [1.26, 0.072], [["L", 1.55, 0.076], ["L", 1.55, 0.004], [1.47, -0.008, 1.39, -0.005], [1.3, -0.001, 1.26, 0.022]])}" fill="${BOW.frog}"/>`;
  return g;
}

// crude scale extractor: px per unit for a panel() transform
function S(T) {
  const a = T([0, 0]).split(",").map(Number);
  const b = T([1, 0]).split(",").map(Number);
  return b[0] - a[0];
}

const outPng = process.argv[2] ?? "bow.png";

// --- head zoom panel ---------------------------------------------------------
const HZ_S = 4200; // px per design unit
const HZ_OX = 7550, HZ_OY = 640; // design origin (x=0, y=0) in canvas px
const Thz = panel(HZ_OX, HZ_OY, HZ_S);
let headZoom = `<rect x="20" y="20" width="1500" height="1000" fill="#cdbfa6"/>`;
// grid every 0.02 design units over the head region, labels every 0.1
let grid = "";
for (let gx = -1.74; gx <= -1.44; gx += 0.02) {
  const [px] = Thz([gx, 0]).split(",");
  const major = Math.abs(Math.round(gx * 10) - gx * 10) < 1e-6;
  grid += `<line x1="${px}" x2="${px}" y1="20" y2="1020" stroke="#8a9bb0" stroke-width="${major ? 1.6 : 0.6}" opacity="0.5"/>`;
  if (major) grid += `<text x="${+px + 3}" y="1012" font-size="18" fill="#456">${gx.toFixed(1)}</text>`;
}
for (let gy = -0.04; gy <= 0.14; gy += 0.02) {
  const py = Thz([0, gy]).split(",")[1];
  const major = Math.abs(Math.round(gy * 10) - gy * 10) < 1e-6;
  grid += `<line x1="20" x2="1520" y1="${py}" y2="${py}" stroke="#8a9bb0" stroke-width="${major ? 1.6 : 0.6}" opacity="0.5"/>`;
  if (major) grid += `<text x="26" y="${+py - 3}" font-size="18" fill="#456">${gy.toFixed(1)}</text>`;
}
headZoom += grid + bowGroup(Thz);
// mark the playable hair tip limit
const [tipPx] = Thz([-1.5, 0]).split(",");
headZoom += `<line x1="${tipPx}" x2="${tipPx}" y1="20" y2="1020" stroke="#e02020" stroke-width="1.4" stroke-dasharray="8 6" opacity="0.7"/>`;
headZoom += `<text x="30" y="48" font-size="22" fill="#333">head ×${HZ_S} — grid 0.02</text>`;

// --- whole bow panel ---------------------------------------------------------
const WB_S = 420;
const Twb = panel(40 + 1.75 * WB_S, 1120, WB_S);
let whole = `<rect x="20" y="1040" width="1500" height="160" fill="#cdbfa6"/>`;
whole += bowGroup(Twb);
whole += `<text x="30" y="1066" font-size="20" fill="#333">whole bow ×${WB_S}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1540" height="1220" style="background:#efe9dd">
${headZoom}
${whole}
</svg>`;

const svgPath = path.join(os.tmpdir(), "bow-view.svg");
fs.writeFileSync(svgPath, svg);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1540, height: 1220 }, deviceScaleFactor: 1 });
await p.goto(`file://${svgPath}`);
await p.screenshot({ path: outPng });
await b.close();
console.log("wrote", outPng);
