/**
 * Standalone violin top-plate design harness: renders the complete body
 * artwork — outline, purfling, f-holes, bridge, varnish gradients — as SVG
 * at large scale, with zoom panels for the f-hole and the bridge and (when
 * present) the Le Brun Stradivarius reference photograph alongside at the
 * same body scale. Iterating the artwork here gives much faster feedback
 * than rebuilding the app: edit the shapes, re-run, look at the PNG.
 *
 *   node e2e/body-harness.mjs [out.png] [refPhoto.jpg]
 *
 * The geometry constants and generator functions (OUTLINE_HALF, offset
 * purfling, parametric f-hole, bridge path) are the design source that
 * src/scene/scene.ts ports — keep the two in sync.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const L = 3.9;

// ---------------------------------------------------------------------------
// Outline: right half, cubic segments [c1x,c1y,c2x,c2y,x,y] from (0,0), y
// negative downward, L = 3.9. Fitted to the measured width profile below;
// joints between segments are tangent-continuous except at the two corner
// tips, which are meant to be points.
const OUTLINE_HALF = [
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

// Width profile edge-scanned from the Le Brun Strad photo: [y, halfWidth]
// in design units (body 1028 px ↔ L, centreline x = 614.7, top y = 774).
const MEASURED = [
  [-0.106, 0.715], [-0.22, 0.808], [-0.326, 0.867], [-0.432, 0.903],
  [-0.539, 0.924], [-0.653, 0.933], [-0.759, 0.926], [-0.865, 0.905],
  [-0.971, 0.873], [-1.085, 0.838], [-1.191, 0.846], [-1.297, 0.857],
  [-1.411, 0.641], [-1.518, 0.618], [-1.624, 0.616], [-1.73, 0.618],
  [-1.844, 0.63], [-1.95, 0.651], [-2.056, 0.685], [-2.17, 0.755],
  [-2.276, 1.026], [-2.382, 1.003], [-2.489, 1.013], [-2.603, 1.06],
  [-2.709, 1.102], [-2.815, 1.14], [-2.921, 1.165], [-3.035, 1.178],
  [-3.141, 1.178], [-3.247, 1.17], [-3.361, 1.142], [-3.468, 1.102],
  [-3.574, 1.045], [-3.68, 0.958], [-3.794, 0.821],
];

// --------------------------------------------------------------------------
// Bezier utilities (plain [x,y] points).

function cubicAt(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
  ];
}

function cubicTanAt(p0, c1, c2, p3, t) {
  const u = 1 - t;
  return [
    3 * u * u * (c1[0] - p0[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]),
    3 * u * u * (c1[1] - p0[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]),
  ];
}

/** Sample the full closed outline (right half + mirrored left half),
 * returning points and unit tangents, in path order. */
function sampleOutline(perSeg = 28) {
  const pts = [], tans = [];
  const segs = [];
  let prev = [0, 0];
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
  for (const [p0, c1, c2, p3] of segs) {
    for (let i = 0; i < perSeg; i++) {
      const t = i / perSeg;
      const p = cubicAt(p0, c1, c2, p3, t);
      const tn = cubicTanAt(p0, c1, c2, p3, t);
      const n = Math.hypot(tn[0], tn[1]) || 1;
      pts.push(p);
      tans.push([tn[0] / n, tn[1] / n]);
    }
  }
  return { pts, tans };
}

function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denom;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

/** Inward offset of the closed outline by d, with self-intersection loops
 * (which appear at the sharp corner tips) clipped out, so the purfling
 * mitres to a clean point toward each corner instead of looping. */
function purflingPoints(d, perSeg = 28) {
  const { pts, tans } = sampleOutline(perSeg);
  // path runs clockwise (y-up frame), so inward is the right-hand normal
  let off = pts.map((p, i) => [p[0] + tans[i][1] * d, p[1] - tans[i][0] * d]);
  // clip self-intersection loops: splice out the short arc between any two
  // crossing segments (window-limited so the big loop is never the one cut)
  const maxLoop = Math.floor(off.length / 6);
  let cut = true;
  while (cut) {
    cut = false;
    outer: for (let i = 0; i < off.length; i++) {
      for (let k = 2; k <= maxLoop; k++) {
        const j = (i + k) % off.length;
        const x = segIntersect(
          off[i], off[(i + 1) % off.length],
          off[j], off[(j + 1) % off.length]
        );
        if (x) {
          if (j > i) off = [...off.slice(0, i + 1), x, ...off.slice(j + 1)];
          else off = [...off.slice(j + 1, i + 1), x];
          cut = true;
          break outer;
        }
      }
    }
  }
  return off;
}

// --------------------------------------------------------------------------
// F-hole: parametric right-hand f-hole in local coordinates (y up, origin at
// its middle, nicks at y≈0). The stem is a cubic spine offset to both sides
// with wing flares, and the nicks are cut into both edges as small triangular
// notches — one connected hole, unioned visually with the two eye circles.
const FHOLE = {
  eyeTop: { c: [-0.098, 0.32], r: 0.038 },
  eyeBot: { c: [0.115, -0.34], r: 0.056 },
  // spine as a polybezier: (A) out of the top eye's right side, hooking up
  // and over it (a crescent of wood stays between eye and hook), then (B)
  // the long lean down, ending in a slim tail at the bottom eye's lower
  // right, so the slot wraps under it — per the Le Brun photo
  spine: [
    [[-0.076, 0.313], [-0.048, 0.325], [-0.01, 0.312], [0.012, 0.268]],
    [[0.012, 0.268], [0.029, 0.218], [0.02, -0.22], [0.156, -0.372]],
  ],
  spineWeights: [0.16, 0.84], // sampling share of each spine segment
  waist: 0.022, // half-width of the slot at the nicks
  // wings: straight-edged blades on the inner (left) edge, ending in points —
  // piecewise-linear "hat" profiles [rise, peak, fall, endValue]
  wingTop: 0.05,
  wingTopHat: [0.06, 0.22, 0.5, 0],
  wingBot: 0.055,
  wingBotHat: [0.56, 0.85, 1.0, 0.3], // stays wide into the under-eye tail
  nickT: 0.585, // where the nicks sit along the spine (the bridge line)
  nickDepth: 0.012,
  nickSpan: 0.022, // half-extent of the nick along the stem, in t
};

function hat(t, [a, peak, b, endVal]) {
  if (t <= a || t >= b) return t >= b && endVal > 0 && t <= 1 ? endVal : 0;
  if (t <= peak) return (t - a) / (peak - a);
  // eased fall, so the blade melts into the stem instead of kinking
  const s = (t - peak) / (b - peak);
  return 1 - (1 - endVal) * s * (2 - s);
}

/** Point + unit tangent on the multi-segment spine at overall t in 0..1. */
function spineAt(t) {
  const { spine, spineWeights } = FHOLE;
  let acc = 0;
  for (let i = 0; i < spine.length; i++) {
    const w = spineWeights[i];
    if (t <= acc + w || i === spine.length - 1) {
      const lt = Math.min(1, Math.max(0, (t - acc) / w));
      const [p0, c1, c2, p3] = spine[i];
      const p = cubicAt(p0, c1, c2, p3, lt);
      const tn = cubicTanAt(p0, c1, c2, p3, lt);
      const m = Math.hypot(tn[0], tn[1]) || 1;
      return { p, tan: [tn[0] / m, tn[1] / m] };
    }
    acc += w;
  }
}

/** Closed polygon for the f-hole stem (nicks included); eyes drawn over it. */
function fHoleStemPoints(n = 72) {
  const { waist, wingTop, wingTopHat, wingBot, wingBotHat, nickT, nickDepth, nickSpan } = FHOLE;
  const right = [], left = [];
  // sample t including exact nick/blade vertices for crisp points
  const ts = [];
  for (let i = 0; i <= n; i++) ts.push(i / n);
  for (const t of [nickT - nickSpan, nickT, nickT + nickSpan,
    wingTopHat[0], wingTopHat[1], wingTopHat[2], wingBotHat[0], wingBotHat[1]])
    ts.push(t);
  ts.sort((a, b) => a - b);
  for (const t of ts) {
    const { p, tan } = spineAt(t);
    const nx = tan[1], ny = -tan[0]; // right-hand normal (spine runs downward)
    let wR = waist;
    let wL = waist + wingTop * hat(t, wingTopHat) + wingBot * hat(t, wingBotHat);
    // nick: a small triangular widening of the slot at the bridge line
    const dn = Math.abs(t - nickT);
    if (dn < nickSpan) {
      const bump = nickDepth * (1 - dn / nickSpan);
      wR += bump;
      wL += bump;
    }
    right.push([p[0] + nx * wR, p[1] + ny * wR]);
    left.push([p[0] - nx * wL, p[1] - ny * wL]);
  }
  return [...right, ...left.reverse()];
}

// --------------------------------------------------------------------------
// Bridge: unsquashed local coordinates, half-width 0.3, crown peak y=0.04.
// The crown quadratic (-0.235,-0.07)..(0,0.04)..(0.235,-0.07) is load-bearing
// (bridgeBreakY in scene.ts) — keep it exactly. Everything below is carving.
function bridgePathD(T) {
  const q = (c, p) => ` Q ${T(c)} ${T(p)}`;
  const l = (p) => ` L ${T(p)}`;
  let d = `M ${T([-0.235, -0.07])}`;
  d += q([0, 0.04], [0.235, -0.07]); // crown
  d += q([0.272, -0.085], [0.258, -0.12]); // ear, curling under
  d += q([0.21, -0.148], [0.208, -0.19]); // waist notch, a deep half-round
  d += q([0.207, -0.23], [0.256, -0.255]); // flaring back out to the leg
  d += l([0.29, -0.307]);
  d += q([0.3, -0.327], [0.28, -0.335]); // foot
  d += l([0.13, -0.335]);
  d += q([0.1, -0.335], [0.095, -0.28]); // inside of the leg
  d += q([0, -0.09], [-0.095, -0.28]); // arch between the feet
  d += q([-0.1, -0.335], [-0.13, -0.335]);
  d += l([-0.28, -0.335]);
  d += q([-0.3, -0.327], [-0.29, -0.307]);
  d += l([-0.256, -0.255]);
  d += q([-0.207, -0.23], [-0.208, -0.19]);
  d += q([-0.21, -0.148], [-0.258, -0.12]);
  d += q([-0.272, -0.085], [-0.235, -0.07]);
  return d + " Z";
}

/** Heart cutout, lobes up, apex down, centred on (0, cy). */
function heartPathD(T, cy = -0.155, w = 0.058, h = 0.082) {
  const x = w / 2, top = cy + h * 0.42, apex = cy - h * 0.58;
  let d = `M ${T([0, cy + h * 0.1])}`;
  d += ` C ${T([0.004, top + 0.012])} ${T([x * 0.55, top + 0.01])} ${T([x * 0.8, top])}`;
  d += ` C ${T([x * 1.15, top - 0.016])} ${T([x, cy - h * 0.1])} ${T([0, apex])}`;
  d += ` C ${T([-x, cy - h * 0.1])} ${T([-x * 1.15, top - 0.016])} ${T([-x * 0.8, top])}`;
  d += ` C ${T([-x * 0.55, top + 0.01])} ${T([-0.004, top + 0.012])} ${T([0, cy + h * 0.1])}`;
  return d + " Z";
}

/** Kidney cutout (a slim comma, outer end raised toward the ear), side = ±1. */
function kidneyPathD(T, side, cx = 0.132, cy = -0.142, tilt = 0.55, size = 1.18) {
  const cos = Math.cos(tilt) * size, sin = Math.sin(tilt) * size;
  // local coords: long axis x (outward), rounded fat outer end, tapered inner
  const p = (x, y) => T([side * (cx + x * cos - y * sin), cy + x * sin + y * cos]);
  let d = `M ${p(-0.038, 0.002)}`;
  d += ` C ${p(-0.032, 0.016)} ${p(-0.005, 0.02)} ${p(0.016, 0.016)}`; // upper edge out
  d += ` C ${p(0.037, 0.011)} ${p(0.038, -0.013)} ${p(0.02, -0.018)}`; // round outer end
  d += ` C ${p(0.0, -0.023)} ${p(-0.026, -0.016)} ${p(-0.036, -0.007)}`; // lower edge back
  d += ` C ${p(-0.041, -0.003)} ${p(-0.041, -0.001)} ${p(-0.038, 0.002)}`; // tapered inner end
  return d + " Z";
}

// --------------------------------------------------------------------------
// SVG assembly.

const BODY_S = 190; // px per design unit, full-body panel
const BODY_CX = 300, BODY_CY = 60;
const outPng = process.argv[2] ?? "body.png";
const refPhoto =
  process.argv[3] ??
  "/tmp/claude-0/-home-user-string-game/5cd83d11-9aad-52c1-8c1d-5736f75a8f7a/scratchpad/reference-strad.jpg";

const WOOD = {
  edge: "#241206",
  purfling: "#2b190a",
  fhole: "#120a04",
  bridge: "#ddba8a",
  bridgeLine: "#6b4826",
};

/** Affine panel transform: design [x,y] (y up) -> "px,py" string. */
function panel(ox, oy, s, rot = 0, mirror = 1) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return (p) => {
    const x = p[0] * mirror, y = p[1];
    const rx = x * cos - y * sin, ry = x * sin + y * cos;
    return `${(ox + rx * s).toFixed(2)},${(oy - ry * s).toFixed(2)}`;
  };
}

function pathFromCubics(T) {
  let d = `M ${T([0, 0])}`;
  for (const [c1x, c1y, c2x, c2y, x, y] of OUTLINE_HALF)
    d += ` C ${T([c1x, c1y])} ${T([c2x, c2y])} ${T([x, y])}`;
  for (let i = OUTLINE_HALF.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = OUTLINE_HALF[i];
    const [ex, ey] = i === 0 ? [0, 0] : [OUTLINE_HALF[i - 1][4], OUTLINE_HALF[i - 1][5]];
    d += ` C ${T([-c2x, c2y])} ${T([-c1x, c1y])} ${T([-ex, ey])}`;
  }
  return d + " Z";
}

function polyD(T, pts, close = true) {
  return `M ${pts.map(T).join(" L ")}${close ? " Z" : ""}`;
}

function fHoleGroup(T) {
  const stem = polyD(T, fHoleStemPoints());
  const [tc, bc] = [FHOLE.eyeTop, FHOLE.eyeBot];
  const [tx, ty] = T(tc.c).split(",");
  const [bx, by] = T(bc.c).split(",");
  const s = parseFloat(T([1, 0]).split(",")[0]) - parseFloat(T([0, 0]).split(",")[0]);
  const rPix = (r) => Math.abs(r * s).toFixed(2);
  return (
    `<path d="${stem}" fill="${WOOD.fhole}"/>` +
    `<circle cx="${tx}" cy="${ty}" r="${rPix(tc.r)}" fill="${WOOD.fhole}"/>` +
    `<circle cx="${bx}" cy="${by}" r="${rPix(bc.r)}" fill="${WOOD.fhole}"/>`
  );
}

function bridgeGroup(T) {
  return (
    `<path d="${bridgePathD(T)}" fill="url(#bridgeGrad)" stroke="${WOOD.bridgeLine}" stroke-width="1.4"/>` +
    `<path d="${heartPathD(T)}" fill="${WOOD.fhole}"/>` +
    `<path d="${kidneyPathD(T, 1)}" fill="${WOOD.fhole}"/>` +
    `<path d="${kidneyPathD(T, -1)}" fill="${WOOD.fhole}"/>`
  );
}

// --- full body panel -------------------------------------------------------
const TB = panel(BODY_CX, BODY_CY, BODY_S);
let body = "";
body += `<path d="${pathFromCubics(TB)}" fill="url(#varnish)" stroke="${WOOD.edge}" stroke-width="2.6"/>`;
// grain + flame overlays, clipped to the plate
body += `<path d="${pathFromCubics(TB)}" fill="url(#flame)"/>`;
body += `<path d="${pathFromCubics(TB)}" fill="url(#grain)"/>`;
const PURFLING_INSET = 0.048;
// the rounded edge overhang catches the light: a faint warm rim between the
// dark outline and the purfling
body += `<path d="${polyD(TB, purflingPoints(0.022))}" fill="none" stroke="#cf9a52" stroke-width="1.4" opacity="0.5"/>`;
body += `<path d="${polyD(TB, purflingPoints(PURFLING_INSET))}" fill="none" stroke="${WOOD.purfling}" stroke-width="1.6"/>`;

// f-holes at their body stations (bridge line at 0.54 L), leaning outward
const FH_X = 0.415, FH_Y = -0.54 * L + 0.02, FH_ROT = 0.16;
for (const side of [1, -1]) {
  const Tf = panel(
    BODY_CX + side * FH_X * BODY_S,
    BODY_CY + -FH_Y * BODY_S,
    BODY_S,
    side * FH_ROT,
    side
  );
  body += fHoleGroup(Tf);
}

// bridge, squashed as in the app, its crown peak on the bridge line
const BRIDGE_SQUASH = 0.62;
{
  const s = BODY_S;
  const Tb = (p) =>
    `${(BODY_CX + p[0] * s).toFixed(2)},${(BODY_CY + (0.54 * L + 0.02) * s - p[1] * s * BRIDGE_SQUASH).toFixed(2)}`;
  body += bridgeGroup(Tb);
}

// guides + measured dots (faint, for fit checking)
let guides = "";
for (const [label, fy] of [
  ["UB widest", 0.16], ["U corners", 0.33], ["waist", 0.41],
  ["bridge", 0.54], ["L corners", 0.58], ["LB widest", 0.79],
]) {
  const y = BODY_CY + fy * L * BODY_S;
  guides += `<line x1="${BODY_CX - 260}" x2="${BODY_CX + 260}" y1="${y}" y2="${y}" stroke="#4a90d9" stroke-width="0.7" stroke-dasharray="5 4" opacity="0.6"/>`;
  guides += `<text x="${BODY_CX - 258}" y="${y - 3}" font-size="11" fill="#4a90d9">${label}</text>`;
}
for (const [y, hw] of MEASURED)
  for (const s of [-1, 1])
    guides += `<circle cx="${BODY_CX + s * hw * BODY_S}" cy="${BODY_CY - y * BODY_S}" r="2" fill="#e02020" opacity="0.55"/>`;

// --- reference photo panel (same body scale) -------------------------------
// Le Brun Strad photo (1280×1920): body spans y = 774..1802 px, centreline
// x = 614.7 (edge-scanned). The drawn outline is overlaid for comparison.
const REF = { top: 774, bottom: 1802, cx: 614.7 };
const REF_CX = 880;
const refScale = (L * BODY_S) / (REF.bottom - REF.top);
const refB64 = fs.existsSync(refPhoto) ? fs.readFileSync(refPhoto).toString("base64") : null;
let ref = "";
if (refB64) {
  const w = 1280 * refScale, h = 1920 * refScale;
  const x = REF_CX - REF.cx * refScale, y = BODY_CY - REF.top * refScale;
  ref = `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/jpeg;base64,${refB64}" preserveAspectRatio="xMidYMid"/>`;
  const Tref = panel(REF_CX, BODY_CY, BODY_S);
  ref += `<path d="${pathFromCubics(Tref)}" fill="none" stroke="#00d8ff" stroke-width="1.6" opacity="0.85"/>`;
  ref += `<path d="${polyD(Tref, purflingPoints(PURFLING_INSET))}" fill="none" stroke="#ff4fd8" stroke-width="1" opacity="0.8"/>`;
}

/** A magnified crop of the reference photo: photo-pixel rect (px0,py0,pw,ph)
 * placed at canvas (dx,dy), scaled by mag. Returns {svg, toCanvas} where
 * toCanvas maps design coords (body frame, y up from body top) into the crop. */
let clipN = 0;
function photoCrop(px0, py0, pw, ph, dx, dy, mag, label) {
  if (!refB64) return { svg: "", designPanel: () => () => "0,0" };
  const id = `crop${clipN++}`;
  const svg =
    `<clipPath id="${id}"><rect x="${dx}" y="${dy}" width="${pw * mag}" height="${ph * mag}"/></clipPath>` +
    `<g clip-path="url(#${id})"><image x="${dx - px0 * mag}" y="${dy - py0 * mag}" width="${1280 * mag}" height="${1920 * mag}" href="data:image/jpeg;base64,${refB64}"/></g>` +
    `<rect x="${dx}" y="${dy}" width="${pw * mag}" height="${ph * mag}" fill="none" stroke="#999"/>` +
    `<text x="${dx + 4}" y="${dy + 16}" font-size="14" fill="#c33">${label}</text>`;
  // design (x, y up, body top = 0) -> photo px -> crop canvas px
  const pxPerUnit = (REF.bottom - REF.top) / L;
  const designPanel = (rot = 0, mirror = 1, ox = 0, oy = 0) => {
    // panel centred at design point (ox, oy)
    const photoX = REF.cx + ox * pxPerUnit;
    const photoY = REF.top - oy * pxPerUnit;
    return panel(dx + (photoX - px0) * mag, dy + (photoY - py0) * mag, pxPerUnit * mag, rot, mirror);
  };
  return { svg, designPanel };
}

// --- zoom panels ------------------------------------------------------------
const FZ_S = 640;
const Tfz = panel(1495, 330, FZ_S);
let fzoom = `<rect x="1330" y="40" width="330" height="560" fill="#d9cbb2"/>` + fHoleGroup(Tfz);
fzoom += `<text x="1335" y="56" font-size="14" fill="#555">f-hole ×${(FZ_S / BODY_S).toFixed(1)}</text>`;

// photo f-hole (viewer-right, centred near design (0.415, -2.086)), with the
// drawn f-hole overlaid in cyan at the same station for direct fitting
{
  const crop = photoCrop(640, 1200, 170, 250, 1670, 40, 2.4, "photo f-hole");
  fzoom += crop.svg;
  const Tof = crop.designPanel(FH_ROT, 1, FH_X, FH_Y);
  fzoom += `<path d="${polyD(Tof, fHoleStemPoints())}" fill="none" stroke="#00d8ff" stroke-width="1.4" opacity="0.9"/>`;
  for (const e of [FHOLE.eyeTop, FHOLE.eyeBot]) {
    const [ex, ey] = Tof(e.c).split(",");
    fzoom += `<circle cx="${ex}" cy="${ey}" r="${(e.r * (1028 / L) * 2.4).toFixed(1)}" fill="none" stroke="#00d8ff" stroke-width="1.4" opacity="0.9"/>`;
  }
}

const BZ_S = 900;
const Tbz = panel(2400, 130, BZ_S);
let bzoom = `<rect x="2110" y="40" width="580" height="400" fill="#d9cbb2"/>` + bridgeGroup(Tbz);
bzoom += `<text x="2115" y="56" font-size="14" fill="#555">bridge (unsquashed)</text>`;
const Tbz2 = panel(1620, 690, BZ_S);
const Tbsq = (p) => Tbz2([p[0], p[1] * BRIDGE_SQUASH]);
bzoom += `<rect x="1330" y="660" width="580" height="270" fill="#d9cbb2"/>` + bridgeGroup(Tbsq);
bzoom += `<text x="1335" y="676" font-size="14" fill="#555">bridge (squashed ×${BRIDGE_SQUASH})</text>`;
// photo bridge for comparison
{
  const crop = photoCrop(530, 1255, 170, 140, 2110, 470, 3, "photo bridge");
  bzoom += crop.svg;
}

// --- gradients ---------------------------------------------------------------
const defs = `
<defs>
  <radialGradient id="varnish" cx="0.5" cy="0.4" r="0.8">
    <stop offset="0" stop-color="#c47829"/>
    <stop offset="0.5" stop-color="#a85c22"/>
    <stop offset="0.85" stop-color="#86451a"/>
    <stop offset="1" stop-color="#6e3714"/>
  </radialGradient>
  <linearGradient id="flame" x1="0" y1="0" x2="0" y2="${0.13 * BODY_S}"
      gradientUnits="userSpaceOnUse" spreadMethod="reflect">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.02"/>
    <stop offset="0.5" stop-color="#000000" stop-opacity="0.015"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0.02"/>
  </linearGradient>
  <linearGradient id="grain" x1="0" y1="0" x2="${0.032 * BODY_S}" y2="0"
      gradientUnits="userSpaceOnUse" spreadMethod="repeat">
    <stop offset="0" stop-color="#000000" stop-opacity="0.035"/>
    <stop offset="0.1" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="bridgeGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#e8caa0"/>
    <stop offset="1" stop-color="#d0a878"/>
  </linearGradient>
</defs>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2740" height="940" style="background:#efe9dd">
${defs}
${ref}
${guides}
${body}
${fzoom}
${bzoom}
</svg>`;

const svgPath = path.join(os.tmpdir(), "body-view.svg");
fs.writeFileSync(svgPath, svg);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 2740, height: 940 }, deviceScaleFactor: 2 });
await p.goto(`file://${svgPath}`);
await p.screenshot({ path: outPng });
await b.close();
console.log("wrote", outPng);
