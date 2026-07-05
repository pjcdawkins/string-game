/**
 * Ingest the openclipart "Violin f hole" SVG, normalise it into the f-hole's
 * local frame (y up, origin at the f-hole centre), and overlay it on the Le
 * Brun photo to verify the fit. Emits the simplified local-frame polygon.
 *
 *   node scripts/fit-svg-fhole.mjs [out.png]
 *
 * Tunables (SCALE via TARGET_H, ROT0, OX, OY) align the raw path to the station.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "/home/user/string-game/node_modules/playwright/index.mjs";
import { parsePathSubpaths, extractD, simplifyClosed } from "./svgpath.mjs";

const SCR = "/tmp/claude-0/-home-user-string-game/5cd83d11-9aad-52c1-8c1d-5736f75a8f7a/scratchpad";
const SVG_SRC = new URL("./violin-f-hole.svg", import.meta.url);
const raw = parsePathSubpaths(extractD(fs.readFileSync(SVG_SRC, "utf8")), 20);
const sub = raw.reduce((a, b) => (b.length > a.length ? b : a));

// flip Y (SVG y-down -> design y-up); MIRROR x so it becomes the right-hand
// f-hole (upper eye toward centre-left, lower eye toward the edge-right), which
// is the orientation makeFHole() builds and the placement code expects.
const MIRROR = (process.env.MIRROR ?? "1") === "1" ? -1 : 1;
let pts = sub.map(([x, y]) => [MIRROR * x, -y]);
const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
const h = Math.max(...ys) - Math.min(...ys), w = Math.max(...xs) - Math.min(...xs);
console.log(`raw bbox w=${w.toFixed(1)} h=${h.toFixed(1)} aspect(w/h)=${(w / h).toFixed(3)} npts=${pts.length}`);

// --- exact fit: solve the similarity transform that lands the SVG's two eye
// centres on the photo's measured eye centres (local frame, pre-station) ------
// eye centres in the raw (y-up, mirrored) SVG frame: centroid of the extreme
// y bands, which are dominated by the two curl blobs
function eyeCentre(topBand) {
  const sorted = [...pts].sort((a, b) => (topBand ? b[1] - a[1] : a[1] - b[1]));
  const band = sorted.slice(0, Math.round(sorted.length * 0.09));
  const sx = band.reduce((a, p) => a + p[0], 0) / band.length;
  const sy = band.reduce((a, p) => a + p[1], 0) / band.length;
  return [sx, sy];
}
const svgUp = eyeCentre(true), svgLo = eyeCentre(false);
// targets: the Le Brun eye centres in the f-hole local frame (upper 6mm eye
// toward centre, lower 9mm eye outboard), measured earlier
const tgtUp = [-0.066, 0.346], tgtLo = [0.168, -0.343];
// similarity transform mapping (svgUp->tgtUp, svgLo->tgtLo)
const dsx = svgLo[0] - svgUp[0], dsy = svgLo[1] - svgUp[1];
const dtx = tgtLo[0] - tgtUp[0], dty = tgtLo[1] - tgtUp[1];
const sLen = Math.hypot(dsx, dsy), tLen = Math.hypot(dtx, dty);
const scl = tLen / sLen;
const ang = Math.atan2(dty, dtx) - Math.atan2(dsy, dsx);
const ca = Math.cos(ang) * scl, sa = Math.sin(ang) * scl;
const xform = ([x, y]) => {
  const dx = x - svgUp[0], dy = y - svgUp[1];
  return [tgtUp[0] + dx * ca - dy * sa, tgtUp[1] + dx * sa + dy * ca];
};
console.log(`svg eyes up=${svgUp.map(v=>v.toFixed(3))} lo=${svgLo.map(v=>v.toFixed(3))} -> scale ${scl.toFixed(3)} rot ${(ang*180/Math.PI).toFixed(1)}deg`);
const local = pts.map(xform);
const simp = simplifyClosed(local, 0.003);
console.log(`local bbox x[${Math.min(...local.map(p=>p[0])).toFixed(3)}, ${Math.max(...local.map(p=>p[0])).toFixed(3)}] y[${Math.min(...local.map(p=>p[1])).toFixed(3)}, ${Math.max(...local.map(p=>p[1])).toFixed(3)}]`);
console.log(`simplified ${local.length} -> ${simp.length}`);

// --- render: raw shape (left) + overlay on photo (right) -------------------
const CX = 614.7, TOP = 774, PXU = 1028 / 3.9;
const FH_X = 0.415, FH_Y = -2.086, FH_ROT = 0.16;
const b64 = fs.readFileSync(`${SCR}/reference-strad.jpg`).toString("base64");
const cosF = Math.cos(FH_ROT), sinF = Math.sin(FH_ROT);

// panel A: raw normalised shape, its own scale
const A = 300, AS = 380;
const toA = ([x, y]) => `${(A + x * AS).toFixed(1)},${(A - y * AS).toFixed(1)}`;
const polyA = simp.map(toA).join(" ");

// panel B: overlay on photo crop
const mag = 3.0, px0 = 648, py0 = 1200, pw = 150, ph = 250, dx = 640, dy = 40;
const toB = ([lx, ly]) => {
  const wx = lx * cosF - ly * sinF + FH_X, wy = lx * sinF + ly * cosF + FH_Y;
  const phx = CX + wx * PXU, phy = TOP - wy * PXU;
  return `${(dx + (phx - px0) * mag).toFixed(1)},${(dy + (phy - py0) * mag).toFixed(1)}`;
};
const polyB = simp.map(toB).join(" ");
const W = dx + pw * mag + 40, H = 820;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#efe9dd">
  <rect x="60" y="40" width="480" height="740" fill="#d9cbb2"/>
  <polygon points="${polyA}" fill="#111"/>
  <text x="64" y="34" font-size="15" fill="#555">normalised SVG (local frame)</text>
  <clipPath id="cp"><rect x="${dx}" y="${dy}" width="${pw*mag}" height="${ph*mag}"/></clipPath>
  <g clip-path="url(#cp)"><image x="${dx-px0*mag}" y="${dy-py0*mag}" width="${1280*mag}" height="${1920*mag}" href="data:image/jpeg;base64,${b64}"/></g>
  <polygon points="${polyB}" fill="#00d8ff" fill-opacity="0.5" stroke="#0088aa" stroke-width="1"/>
  <text x="${dx}" y="34" font-size="15" fill="#c33">overlay on photo</text>
</svg>`;
const svgPath = path.join(os.tmpdir(), "svg-fhole-fit.svg");
fs.writeFileSync(svgPath, svg);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await p.goto(`file://${svgPath}`);
await p.screenshot({ path: process.argv[2] ?? `${SCR}/svg-fit.png` });
await b.close();

// emit the fitted outline as the single source of truth: a JSON (for the
// design harness) and a TS module (imported by the app). Regenerate by
// re-running this script; do not hand-edit the outputs.
const outPts = simp.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
const here = new URL(".", import.meta.url);
fs.writeFileSync(new URL("./fhole-outline.json", here), JSON.stringify(outPts));
const ts =
  `// GENERATED by scripts/fit-svg-fhole.mjs from scripts/violin-f-hole.svg\n` +
  `// (openclipart "Violin f hole" by Alvin, public domain). Do not hand-edit —\n` +
  `// re-run the fitter to regenerate. The f-hole is one filled path (the eyes\n` +
  `// are solid rounded ends), fitted to the Le Brun Strad's right f-hole in the\n` +
  `// local frame (y up, origin at the f-hole centre; mirror x for the left).\n` +
  `export const FHOLE_OUTLINE: [number, number][] = [\n` +
  outPts.map(([x, y]) => `  [${x}, ${y}],`).join("\n") +
  `\n];\n`;
fs.writeFileSync(new URL("../src/scene/fholeOutline.ts", here), ts);
console.log(`wrote overlay, scripts/fhole-outline.json, src/scene/fholeOutline.ts (${outPts.length} pts)`);
